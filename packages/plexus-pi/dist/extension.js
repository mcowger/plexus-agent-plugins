// @bun
// ../plexus-models/src/suppress.ts
function parseSuppressionPatterns(raw) {
  if (!raw)
    return [];
  const items = Array.isArray(raw) ? raw : raw.split(/[\n,;]+/);
  return items.map((s) => s.trim()).filter((s) => s.length > 0);
}
function getEnvSuppressedModels() {
  const env = typeof process !== "undefined" && process?.env ? process.env : {};
  const raw = env.PLEXUS_SUPPRESS_MODELS ?? env.PLEXUS_EXCLUDE_MODELS;
  return parseSuppressionPatterns(raw);
}
function isModelSuppressed(model, patterns) {
  const envPatterns = getEnvSuppressedModels();
  const explicitPatterns = parseSuppressionPatterns(patterns);
  const allPatterns = [...envPatterns, ...explicitPatterns];
  if (allPatterns.length === 0)
    return false;
  const id = model.id.toLowerCase();
  const name = (model.name ?? "").toLowerCase();
  const shortId = id.includes("/") ? id.split("/").pop() : id.includes(":") ? id.split(":").pop() : id;
  for (const pattern of allPatterns) {
    if (matchesPattern(id, name, shortId, pattern)) {
      return true;
    }
  }
  return false;
}
function matchesPattern(id, name, shortId, pattern) {
  const p = pattern.toLowerCase();
  if (p.startsWith("regex:")) {
    try {
      const re = new RegExp(pattern.slice(6), "i");
      return re.test(id) || re.test(name) || re.test(shortId);
    } catch {
      return false;
    }
  }
  if (p.includes("*") || p.includes("?")) {
    const regexStr = "^" + p.replace(/([.+^${}()|[\]\\])/g, "\\$1").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
    try {
      const re = new RegExp(regexStr, "i");
      return re.test(id) || re.test(name) || re.test(shortId);
    } catch {
      return false;
    }
  }
  return id === p || name === p || shortId === p;
}
// ../plexus-models/src/convert.ts
var REASONING_PARAMS = new Set(["reasoning", "include_reasoning", "reasoning_effort"]);
var NON_CHAT_PATTERN = /(?:^|[\W_])(?:embed(?:ding|dings)?|transcri(?:be[ds]?|ptions?)|whisper|speech[\W_]*to[\W_]*text|stt|text[\W_]*to[\W_]*speech|tts|image(?:[\W_]*(?:gen(?:eration)?|\d+))?|diffusion|dall[\W_]*e|stable[\W_]*diffusion|sdxl|dream)(?:$|[\W_])/i;
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
function adjustBaseUrl(baseUrl, preferredApi, anthropicBaseStyle = "root") {
  const stripped = baseUrl.replace(/\/+$/, "");
  switch (preferredApi) {
    case "anthropic-messages":
      return anthropicBaseStyle === "root" && stripped.endsWith("/v1") ? stripped.slice(0, -3) : stripped;
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
  if (v == null || v < 100) {
    return 32768;
  }
  return v;
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
function isChatModel(model) {
  if (!model.id)
    return false;
  const inputModalities = model.architecture?.input_modalities;
  if (inputModalities !== undefined && inputModalities.length > 0 && !inputModalities.includes("text")) {
    return false;
  }
  const outputModalities = model.architecture?.output_modalities;
  if (outputModalities !== undefined && (outputModalities.length === 0 || outputModalities.some((m) => m !== "text"))) {
    return false;
  }
  const modality = model.architecture?.modality;
  if (modality?.includes("->")) {
    const input = modality.split("->")[0] ?? "";
    if (!input.toLowerCase().includes("text"))
      return false;
    const output = modality.split("->").at(-1) ?? "";
    const outputTokens = output.toLowerCase().split(/[+,]/).map((t) => t.trim()).filter((t) => t.length > 0);
    if (outputTokens.length === 0 || outputTokens.some((t) => t !== "text"))
      return false;
  }
  const apiHints = Array.isArray(model.preferred_api) ? model.preferred_api.join(" ") : model.preferred_api ?? "";
  return !NON_CHAT_PATTERN.test(`${model.id} ${model.name ?? ""} ${apiHints}`);
}
function parseSuppressionPatterns2(input) {
  if (!input)
    return [];
  const rawItems = Array.isArray(input) ? input : [input];
  const patterns = [];
  for (const item of rawItems) {
    if (!item || typeof item !== "string")
      continue;
    const parts = item.split(/[\n,]/);
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length > 0) {
        patterns.push(trimmed);
      }
    }
  }
  return patterns;
}
function isSuppressedModel(model, suppress) {
  if (!model || !model.id)
    return false;
  const patterns = parseSuppressionPatterns2(suppress);
  if (patterns.length === 0)
    return false;
  const idLower = model.id.toLowerCase();
  const nameLower = (model.name ?? "").toLowerCase();
  for (const pattern of patterns) {
    const patternLower = pattern.toLowerCase();
    if (idLower === patternLower || nameLower && nameLower === patternLower) {
      return true;
    }
    if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
      const lastSlash = pattern.lastIndexOf("/");
      const regexBody = pattern.slice(1, lastSlash);
      const regexFlags = pattern.slice(lastSlash + 1) || "i";
      try {
        const re = new RegExp(regexBody, regexFlags);
        if (re.test(model.id) || model.name && re.test(model.name)) {
          return true;
        }
      } catch {}
    }
    if (pattern.includes("*") || pattern.includes("?")) {
      try {
        const escaped = patternLower.replace(/[.+^$()|[{}]\\]/g, "\\$&");
        const regexStr = "^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
        const globRe = new RegExp(regexStr, "i");
        if (globRe.test(model.id) || model.name && globRe.test(model.name)) {
          return true;
        }
      } catch {}
    }
  }
  return false;
}
function convertDescriptors(models, baseUrl, suppress) {
  const result = [];
  for (const m of models) {
    if (!isChatModel(m))
      continue;
    if (isSuppressedModel(m, suppress))
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
async function fetchPlexusModels(apiKey, modelsUrl, timeoutMs = DEFAULT_MODELS_FETCH_TIMEOUT_MS, etag, signal) {
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const headers = { Accept: "application/json" };
    if (apiKey)
      headers.Authorization = `Bearer ${apiKey}`;
    if (etag)
      headers["If-None-Match"] = etag;
    const res = await fetch(modelsUrl, {
      headers,
      signal: requestSignal
    });
    if (res.status === 304) {
      return { models: [], notModified: true };
    }
    if (!res.ok) {
      throw new Error(`Plexus models fetch failed: ${res.status} ${res.statusText}`);
    }
    const raw = await res.json();
    const responseEtag = res.headers.get("etag") ?? undefined;
    return { models: raw.data ?? [], raw, etag: responseEtag };
  } catch (err) {
    if (signal?.aborted)
      throw err;
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
var toPlexusApiBase = (raw) => {
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
async function saveBaseUrl(baseUrl) {
  await mkdir(getConfigDir(), { recursive: true });
  const { defaultModel: _defaultModel, ...existing } = getConfigSync();
  const config = {
    ...existing,
    baseUrl: normalizeConfigBaseUrl(baseUrl)
  };
  await writeFile(getConfigPath(), `${JSON.stringify(config, null, 2)}
`, "utf8");
  cachedConfig = config;
}
function getBaseUrlResolution() {
  const config = getConfigSync();
  const apiUrl = resolveStringOption(process.env[ENV_API_URL]);
  if (apiUrl)
    return { baseUrl: apiUrl, source: ENV_API_URL };
  const baseUrl = resolveStringOption(process.env[ENV_BASE_URL]);
  if (baseUrl)
    return { baseUrl, source: ENV_BASE_URL };
  const saved = resolveStringOption(config.baseUrl);
  return { baseUrl: saved ?? null, source: saved ? "saved" : "none" };
}
function getEnvApiKey() {
  return resolveStringOption(process.env[ENV_API_KEY]) ?? null;
}
function getModelsUrl() {
  const { baseUrl } = getBaseUrlResolution();
  return baseUrl ? `${toPlexusApiBase(baseUrl)}/models` : null;
}
function getBaseUrl() {
  const { baseUrl } = getBaseUrlResolution();
  return baseUrl ? toPlexusApiBase(baseUrl) : null;
}
function getSuppressedModels() {
  const config = getConfigSync();
  const envSuppressed = getEnvSuppressedModels();
  const configSuppressed = parseSuppressionPatterns(config.suppressModels ?? config.suppress);
  return [...envSuppressed, ...configSuppressed];
}

// src/cache.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "fs";
import { join as join2 } from "path";
import { getAgentDir as getAgentDir2 } from "@earendil-works/pi-coding-agent";
function readStoredModelsSync() {
  try {
    const path = join2(getAgentDir2(), "models-store.json");
    if (!existsSync2(path))
      return null;
    const data = JSON.parse(readFileSync2(path, "utf8"));
    const plexus = data["plexus"];
    if (!plexus || typeof plexus !== "object" || Array.isArray(plexus))
      return null;
    const catalog = plexus;
    if (!Array.isArray(catalog["models"]))
      return null;
    return {
      models: catalog["models"],
      checkedAt: typeof catalog["checkedAt"] === "number" ? catalog["checkedAt"] : 0
    };
  } catch {
    return null;
  }
}

// src/log.ts
import { mkdir as mkdir2, appendFile } from "fs/promises";
import { join as join3 } from "path";
import { getAgentDir as getAgentDir3 } from "@earendil-works/pi-coding-agent";
var getCacheDir = () => join3(getAgentDir3(), "extensions", "plexus");
var getLogPath = () => join3(getCacheDir(), "plexus.log");
var dirEnsured = false;
function log(message, data) {
  writeLogLine(message, data);
}
async function writeLogLine(message, data) {
  try {
    if (!dirEnsured) {
      await mkdir2(getCacheDir(), { recursive: true });
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
import { getModel } from "@earendil-works/pi-ai/compat";
var MINIMUM_OUTPUT_TOKENS = 8192;
function descriptorToPiModel(descriptor) {
  let builtinModel;
  if (descriptor.piProvider && descriptor.piModel) {
    try {
      builtinModel = getModel(descriptor.piProvider, descriptor.piModel);
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
    provider: descriptor.provider,
    baseUrl: descriptor.baseUrl,
    reasoning: descriptor.reasoning,
    input: descriptor.input,
    cost,
    contextWindow: descriptor.contextWindow,
    maxTokens: Math.max(descriptor.maxTokens, MINIMUM_OUTPUT_TOKENS),
    ...builtinModel?.thinkingLevelMap !== undefined ? { thinkingLevelMap: builtinModel.thinkingLevelMap } : {},
    ...builtinModel?.headers !== undefined ? { headers: builtinModel.headers } : {},
    ...compat !== undefined ? { compat } : {}
  };
}

// src/gemini-malformed-retry.ts
var MALFORMED_LEAK_PATTERN = /(?:print\()?call:\s*default_api[.:]|default_api\.\w+\s*\(/;
var MALFORMED_DIAGNOSTIC_PATTERN = /\bmalformed[\s_-]?function[\s_-]?call\b/i;
var TRUNCATED_JSON_PATTERN = /\bUnexpected end of JSON input\b/i;
var PROVIDER_CONNECTION_CLOSED_PATTERN = /\bprovider connection closed\b/i;
var NORMALIZED_PREFIX = "MALFORMED_FUNCTION_CALL:";
var TRUNCATED_JSON_PREFIX = "TRUNCATED_JSON_RESPONSE:";
var PROVIDER_CONNECTION_CLOSED_PREFIX = "PROVIDER_CONNECTION_CLOSED:";
var NORMALIZED_MESSAGE = `${NORMALIZED_PREFIX} Gemini emitted a malformed tool call (its internal ` + `function-call syntax leaked as text). This is a transient model failure \u2014 ` + `please retry your request.`;
var TRUNCATED_JSON_MESSAGE = `${TRUNCATED_JSON_PREFIX} Unexpected end of JSON input. The upstream provider ` + `returned a truncated JSON response. This is a transient provider failure \u2014 ` + `please retry your request.`;
var PROVIDER_CONNECTION_CLOSED_MESSAGE = `${PROVIDER_CONNECTION_CLOSED_PREFIX} Provider connection closed. The upstream provider ` + `dropped the request. This is a transient provider failure \u2014 please retry your request.`;
function hasLeakedFunctionCall(content) {
  if (!Array.isArray(content))
    return false;
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string" && MALFORMED_LEAK_PATTERN.test(block.text)) {
      return true;
    }
  }
  return false;
}
function hasToolCall(content) {
  return Array.isArray(content) && content.some((block) => block?.type === "toolCall");
}
function normalizeMalformedFunctionCall(message, providerName) {
  if (!message || message.role !== "assistant" || message.provider !== providerName || message.stopReason !== "error") {
    return;
  }
  if (typeof message.errorMessage === "string" && (message.errorMessage.startsWith(NORMALIZED_PREFIX) || message.errorMessage.startsWith(TRUNCATED_JSON_PREFIX) || message.errorMessage.startsWith(PROVIDER_CONNECTION_CLOSED_PREFIX))) {
    return;
  }
  if (hasToolCall(message.content))
    return;
  if (typeof message.errorMessage === "string" && TRUNCATED_JSON_PATTERN.test(message.errorMessage)) {
    log("retryable-error: retagged truncated JSON response for retry", {
      model: message.model
    });
    return { message: { ...message, errorMessage: TRUNCATED_JSON_MESSAGE } };
  }
  if (typeof message.errorMessage === "string" && PROVIDER_CONNECTION_CLOSED_PATTERN.test(message.errorMessage)) {
    log("retryable-error: retagged closed provider connection for retry", {
      model: message.model
    });
    return { message: { ...message, errorMessage: PROVIDER_CONNECTION_CLOSED_MESSAGE } };
  }
  const via = hasLeakedFunctionCall(message.content) ? "leak" : typeof message.errorMessage === "string" && MALFORMED_DIAGNOSTIC_PATTERN.test(message.errorMessage) ? "diagnostic" : undefined;
  if (!via)
    return;
  log("gemini-malformed-retry: retagged MALFORMED_FUNCTION_CALL for retry", {
    model: message.model,
    via
  });
  return { message: { ...message, errorMessage: NORMALIZED_MESSAGE } };
}

// src/extension.ts
var PROVIDER_NAME = "plexus";
var PROVIDER_API_KEY_TEMPLATE = "${PLEXUS_API_KEY}";
var PLEXUS_CREDENTIAL_EXPIRES_AT = 253402300799000;
var PLACEHOLDER_BASE_URL = "http://localhost/v1";
var currentModels = [];
var catalogSource = "none";
function enforceMinimumOutputTokens(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return payload;
  const next = { ...payload };
  let changed = false;
  for (const field of ["max_completion_tokens", "max_tokens", "max_output_tokens"]) {
    const value = next[field];
    if (typeof value === "number" && Number.isFinite(value) && value < MINIMUM_OUTPUT_TOKENS) {
      next[field] = MINIMUM_OUTPUT_TOKENS;
      changed = true;
    }
  }
  const generationConfig = next["generationConfig"];
  if (generationConfig && typeof generationConfig === "object" && !Array.isArray(generationConfig)) {
    const maxOutputTokens = generationConfig["maxOutputTokens"];
    if (typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens) && maxOutputTokens < MINIMUM_OUTPUT_TOKENS) {
      next["generationConfig"] = {
        ...generationConfig,
        maxOutputTokens: MINIMUM_OUTPUT_TOKENS
      };
      changed = true;
    }
  }
  return changed ? next : payload;
}
function plexusExtension(pi) {
  const envApiKey = getEnvApiKey();
  const startupBaseUrl = getBaseUrl();
  const suppressPatterns = getSuppressedModels();
  const storedCatalog = readStoredModelsSync();
  const startupModels = (storedCatalog?.models ?? []).filter((model) => !isModelSuppressed({ id: model.id, name: model.name }, suppressPatterns));
  currentModels = startupModels;
  catalogSource = startupModels.length > 0 ? "host store" : "none";
  pi.on("before_provider_request", (event, ctx) => ctx.model?.provider === PROVIDER_NAME ? enforceMinimumOutputTokens(event.payload) : undefined);
  log("startup", {
    baseUrl: startupBaseUrl,
    hasEnvApiKey: !!envApiKey,
    hostStoredModelCount: startupModels.length
  });
  pi.on("message_end", (event) => normalizeMalformedFunctionCall(event.message, PROVIDER_NAME));
  pi.registerProvider(PROVIDER_NAME, {
    api: "openai-completions",
    ...envApiKey ? { apiKey: PROVIDER_API_KEY_TEMPLATE } : {},
    authHeader: true,
    baseUrl: startupBaseUrl ?? PLACEHOLDER_BASE_URL,
    models: startupModels,
    refreshModels: refreshPlexusModels,
    oauth: createPlexusLoginProvider()
  });
  pi.registerCommand("plexus", {
    description: "Plexus provider commands: refresh, status (setup: /login plexus)",
    getArgumentCompletions: (prefix) => {
      const subcommands = [
        { value: "refresh", label: "refresh", description: "Refresh Plexus models from the API" },
        { value: "status", label: "status", description: "Show Plexus configuration and catalog status" }
      ];
      return prefix.includes(" ") ? null : subcommands.filter((command) => command.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "refresh" || sub === "")
        return handleRefresh(ctx);
      if (sub === "status")
        return handleStatus(ctx);
      ctx.ui.notify(`Unknown sub-command: "${args}". Use /login plexus, /plexus refresh, or /plexus status.`, "warning");
    }
  });
}
async function refreshPlexusModels(context) {
  const baseUrl = getBaseUrl();
  const modelsUrl = getModelsUrl();
  const apiKey = credentialApiKey(context.credential) ?? getEnvApiKey() ?? undefined;
  const suppress = getSuppressedModels();
  if (!context.allowNetwork || !apiKey || !modelsUrl || !baseUrl) {
    if (currentModels.length > 0) {
      const filteredCurrent = currentModels.filter((m) => !isModelSuppressed({ id: m.id, name: m.name }, suppress));
      await context.publish({
        persist: { models: filteredCurrent, checkedAt: Date.now() },
        update: () => {
          currentModels = filteredCurrent;
        }
      });
      return filteredCurrent;
    }
    const restored = await restoreStoredModels(context);
    if (restored)
      return restored;
    throw new Error(!modelsUrl || !baseUrl ? "Plexus base URL not configured. Run /login plexus first." : "No Plexus API key configured. Run /login plexus first.");
  }
  try {
    const { models: apiModels } = await fetchPlexusModels(apiKey, modelsUrl, undefined, undefined, context.signal);
    const descriptors = convertDescriptors(apiModels, baseUrl, suppress);
    const piModels = descriptors.map(descriptorToPiModel);
    const published = await context.publish({
      persist: { models: piModels, checkedAt: Date.now() },
      update: () => {
        currentModels = piModels;
        catalogSource = "live refresh";
      }
    });
    if (!published) {
      log("refreshModels: publication superseded by a newer refresh", {});
    }
    log("refreshModels: fetched", { count: piModels.length });
    return piModels;
  } catch (error) {
    log("refreshModels: fetch failed", { error: String(error) });
    throw error;
  }
}
async function restoreStoredModels(context) {
  const stored = context.stored;
  if (!stored || stored.models.length === 0)
    return;
  const suppress = getSuppressedModels();
  const models = stored.models.filter((m) => !isModelSuppressed({ id: m.id, name: m.name }, suppress));
  await context.publish({
    update: () => {
      currentModels = models;
      catalogSource = "host store";
    }
  });
  log("refreshModels: restored from store", { count: models.length });
  return models;
}
function credentialApiKey(credential) {
  if (!credential)
    return;
  if (credential.type === "api_key")
    return credential.key || undefined;
  return String(credential.access || credential.refresh || "") || undefined;
}
function createPlexusLoginProvider() {
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
      return {
        access: apiKey,
        refresh: apiKey,
        expires: PLEXUS_CREDENTIAL_EXPIRES_AT,
        plexusBaseUrl: baseUrl
      };
    },
    async refreshToken(credentials, signal) {
      signal.throwIfAborted();
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
      return models.map((model) => model.provider === PROVIDER_NAME ? { ...model, baseUrl: adjustBaseUrl(apiBase, model.api) } : model);
    }
  };
}
async function handleRefresh(ctx) {
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME);
  if (!apiKey) {
    ctx.ui.notify("No Plexus API key configured. Run /login plexus first.", "error");
    return;
  }
  ctx.ui.notify("Refreshing Plexus models\u2026", "info");
  const result = await ctx.modelRegistry.refresh({ providers: [PROVIDER_NAME], force: true });
  if (result.aborted) {
    ctx.ui.notify("Plexus model refresh was cancelled.", "warning");
    return;
  }
  const refreshError = result.errors.get(PROVIDER_NAME);
  if (refreshError) {
    ctx.ui.notify(`Plexus model refresh failed: ${refreshError.message}`, "error");
    return;
  }
  ctx.ui.notify(currentModels.length > 0 ? `Refreshed ${currentModels.length} Plexus models` : "Refresh finished but no Plexus models are available. Check the Plexus server and /login plexus.", currentModels.length > 0 ? "info" : "warning");
}
async function handleStatus(ctx) {
  const baseUrl = getBaseUrlResolution();
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_NAME);
  ctx.ui.notify([
    `Plexus base URL: ${baseUrl.baseUrl ?? "not configured"} (${baseUrl.source})`,
    `API key: ${apiKey ? getEnvApiKey() ? "host credential or PLEXUS_API_KEY fallback" : "host credential" : "not configured"}`,
    `Catalog: ${currentModels.length} models (${catalogSource})`,
    "Default model: managed by Pi. Use /model and save the selection there."
  ].join(`
`), "info");
}
export {
  plexusExtension as default,
  enforceMinimumOutputTokens
};
