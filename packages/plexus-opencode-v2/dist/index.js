// @bun
// src/plugin.ts
import { Plugin, Provider } from "@opencode/plugin";

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
function isChatModel(model) {
  if (!model.id)
    return false;
  if (model.type !== undefined && model.type !== "text")
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
// src/cache.ts
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

// src/constants.ts
var PLEXUS_PROVIDER_ID = "plexus";
var PLEXUS_PROVIDER_NAME = "Plexus";
var PLEXUS_PLUGIN_ID = "@mcowger/opencode-plexus";
var PLEXUS_INTEGRATION_ID = "plexus";
var OPENAI_COMPATIBLE_PKG = "aisdk:@ai-sdk/openai-compatible";
var ANTHROPIC_PKG = "aisdk:@ai-sdk/anthropic";
var GOOGLE_PKG = "aisdk:@ai-sdk/google";
var OPENAI_RESPONSES_PKG = "aisdk:@ai-sdk/openai";
var PLEXUS_BASE_URL_OPTION = "plexusBaseURL";
var ENV_BASE_URL = "PLEXUS_BASE_URL";
var ENV_API_URL = "PLEXUS_API_URL";
var ENV_API_KEY = "PLEXUS_API_KEY";
var PLEXUS_SUPPRESS_MODELS_OPTION = "suppressModels";
var MODELS_FETCH_TIMEOUT_MS = 1e4;
var REFRESH_TTL_MS = 60000;
var CACHE_VERSION = 2;
var PLACEHOLDER_MODEL_ID = "plexus-unconfigured";
var PLEXUS_REFRESH_COMMAND = "plexus-refresh";

// src/cache.ts
var PLUGIN_SUBDIR = join("plugins", "plexus");
var CACHE_FILE = "models-cache-v2.json";
var RAW_FILE = "models-raw.json";
function getDir() {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(dataHome, "opencode", PLUGIN_SUBDIR);
}
function filterCachedModels(models, suppress) {
  return models.filter((model) => {
    if (isModelSuppressed({ id: model.id, name: model.name }, suppress))
      return false;
    return isChatModel({
      id: model.id,
      name: model.name,
      architecture: {
        input_modalities: model.capabilities.input,
        output_modalities: model.capabilities.output
      }
    });
  });
}
async function readCachedModels(suppress) {
  try {
    const content = await readFile(join(getDir(), CACHE_FILE), "utf8");
    const parsed = JSON.parse(content);
    if (!parsed || !Array.isArray(parsed.models))
      return null;
    if (parsed.version !== CACHE_VERSION)
      return null;
    return {
      models: filterCachedModels(parsed.models, suppress),
      etag: typeof parsed.etag === "string" ? parsed.etag : undefined
    };
  } catch {
    return null;
  }
}
async function writeCache(models, raw, etag) {
  try {
    const dir = getDir();
    await mkdir(dir, { recursive: true });
    const cache = { version: CACHE_VERSION, models, timestamp: Date.now(), etag };
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
function metadataBaseURL(credential) {
  if (!credential)
    return;
  const fromMetadata = resolveStringOption(credential.metadata?.[PLEXUS_BASE_URL_OPTION]);
  if (fromMetadata)
    return fromMetadata;
  const rawConfig = credential.configuration?.[PLEXUS_BASE_URL_OPTION];
  return typeof rawConfig === "string" ? resolveStringOption(rawConfig) : undefined;
}
function resolveConfig(options, credential) {
  const envBaseURL = process.env[ENV_API_URL] ?? process.env[ENV_BASE_URL];
  const envApiKey = process.env[ENV_API_KEY];
  const metaBaseURL = credential ? metadataBaseURL(credential) : undefined;
  const optBaseURL = resolveStringOption(options?.[PLEXUS_BASE_URL_OPTION]);
  const optApiKey = resolveStringOption(options?.["apiKey"]);
  const baseURL = (envBaseURL ? rootURL(envBaseURL) : undefined) || (metaBaseURL ? rootURL(metaBaseURL) : undefined) || (optBaseURL ? rootURL(optBaseURL) : undefined) || undefined;
  const apiKey = (envApiKey ? envApiKey.trim() : undefined) || credential?.key?.trim() || optApiKey || undefined;
  return {
    baseURL: baseURL || undefined,
    apiKey: apiKey || undefined
  };
}
function getSuppressedModels(options) {
  const envSuppressed = getEnvSuppressedModels();
  const opt = options?.["suppressModels"] ?? options?.["suppress"] ?? options?.["suppress_models"];
  const optSuppressed = parseSuppressionPatterns(opt);
  return [...envSuppressed, ...optSuppressed];
}

// src/log.ts
import { appendFileSync, mkdirSync } from "fs";
import { join as join2 } from "path";
function createLogger(prefix = "plexus") {
  function log(level, message) {
    const line = `[${prefix}] ${message}`;
    try {
      if (level === "error")
        console.error(line);
      else if (level === "warn")
        console.warn(line);
      else
        console.log(line);
    } catch {}
    try {
      const dir = getDir();
      mkdirSync(dir, { recursive: true });
      appendFileSync(join2(dir, "plugin.log"), `${new Date().toISOString()} ${level.toUpperCase()} ${message}
`);
    } catch {}
  }
  return {
    info: (message) => log("info", message),
    warn: (message) => log("warn", message),
    error: (message) => log("error", message)
  };
}

// src/mapper.ts
var REASONING_PARAMS2 = new Set(["reasoning", "include_reasoning", "reasoning_effort"]);
var OPEN_CODE_NONE = "none";
var DEFAULT_CONTEXT = 250000;
var PER_TOKEN_TO_PER_MILLION = 1e6;
function normalizeReasoningEffort(value) {
  return value === null || value === "off" ? OPEN_CODE_NONE : value;
}
function reasoningVariantSettings(preferredApi, effort) {
  switch (preferredApi) {
    case "anthropic-messages":
      return { effort };
    case "google-generative-ai":
      return { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } };
    default:
      return { reasoningEffort: effort };
  }
}
function buildReasoningVariants(model, preferredApi, hasReasoning) {
  if (!hasReasoning)
    return;
  const effortOption = model.reasoning_options?.find((option) => option.type === "effort");
  if (!effortOption)
    return;
  return effortOption.values.map((value) => {
    const effort = normalizeReasoningEffort(value);
    return { id: effort, settings: reasoningVariantSettings(preferredApi, effort) };
  });
}
function resolveModelPackage(preferredApi) {
  switch (preferredApi) {
    case "anthropic-messages":
      return ANTHROPIC_PKG;
    case "google-generative-ai":
      return GOOGLE_PKG;
    case "openai-responses":
      return OPENAI_RESPONSES_PKG;
    case "openai-completions":
    default:
      return;
  }
}
function resolveModelBaseURL(preferredApi, apiBaseURL) {
  return adjustBaseUrl(apiBaseURL, preferredApi, "versioned");
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
    return [
      {
        inputTokensAbove: tier.input_tokens_above,
        input: parsePrice(tier.prompt ?? pricing.prompt),
        output: parsePrice(tier.completion ?? pricing.completion),
        cacheRead: parsePrice(tier.input_cache_read ?? pricing.input_cache_read),
        cacheWrite: parsePrice(tier.input_cache_write ?? pricing.input_cache_write)
      }
    ];
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
function releaseTime(created) {
  if (typeof created !== "number" || !Number.isFinite(created) || created <= 0)
    return 0;
  return Math.floor(created * 1000);
}
function reasoningCompatibility(model, preferredApi) {
  if (preferredApi === "openai-completions" && model.id.toLowerCase().includes("deepseek")) {
    return { reasoningField: "reasoning_content" };
  }
  return;
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
function orderModelsByApiBase(models) {
  const current = [];
  const beta = [];
  for (const model of models) {
    const api = (model.settings?.baseURL ?? "").trim().replace(/\/+$/, "");
    if (api.endsWith("/v1beta"))
      beta.push(model);
    else
      current.push(model);
  }
  return [...current, ...beta];
}
function buildModels(models, apiBaseURL, suppress) {
  const result = [];
  for (const m of models) {
    if (!m.id || typeof m.id !== "string")
      continue;
    if (m.id.includes("/"))
      continue;
    if (!isChatModel(m))
      continue;
    if (isModelSuppressed(m, suppress))
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
    const pricingTiers = buildPricingTiers(m);
    const preferredApi = mapPreferredApi(m.preferred_api);
    const pkg = resolveModelPackage(preferredApi);
    const compatibility = reasoningCompatibility(m, preferredApi);
    const hasReasoning = params.some((p) => REASONING_PARAMS2.has(p));
    const variants = buildReasoningVariants(m, preferredApi, hasReasoning);
    const cost = [];
    if (promptPrice > 0 || completionPrice > 0) {
      cost.push({
        input: promptPrice,
        output: completionPrice,
        cache: { read: cacheReadPrice, write: cacheWritePrice }
      });
    }
    for (const tier of pricingTiers ?? []) {
      cost.push({
        tier: { type: "context", size: tier.inputTokensAbove },
        input: tier.input,
        output: tier.output,
        cache: { read: tier.cacheRead, write: tier.cacheWrite }
      });
    }
    result.push({
      id: m.id,
      modelID: m.id,
      providerID: "plexus",
      name: m.name ?? m.id,
      ...compatibility ? { compatibility } : {},
      ...pkg ? { package: pkg } : {},
      settings: { baseURL: resolveModelBaseURL(preferredApi, apiBaseURL) },
      capabilities: {
        tools: params.includes("tools"),
        input: inputModalities,
        output: outputModalities
      },
      variants: variants ?? [],
      time: { released: releaseTime(m.created) },
      cost,
      status: "active",
      enabled: true,
      limit: {
        context: contextLength,
        output: maxOutput
      }
    });
  }
  return orderModelsByApiBase(result);
}
function placeholderModel() {
  return {
    id: "plexus-unconfigured",
    modelID: "plexus-unconfigured",
    providerID: "plexus",
    name: "Plexus (run /connect to configure)",
    settings: {},
    capabilities: { tools: false, input: ["text"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: 1024, output: 1024 }
  };
}

// src/plugin.ts
var lastRefresh = null;
var inFlightRefresh = null;
function toModelInfo(models) {
  return models;
}
async function resolveConnectionCredential(ctx, log) {
  try {
    const connection = await ctx.integration.connection.active(PLEXUS_INTEGRATION_ID);
    if (!connection)
      return { connection: undefined, credential: undefined };
    const resolved = await ctx.integration.connection.resolve(connection);
    if (!resolved || resolved.type !== "key") {
      return { connection, credential: undefined };
    }
    return {
      connection,
      credential: {
        key: resolved.key,
        metadata: resolved.metadata ?? undefined,
        configuration: resolved.configuration ?? undefined
      }
    };
  } catch (e) {
    log.warn(`Integration connection lookup failed: ${String(e)}`);
    return { connection: undefined, credential: undefined };
  }
}
function refreshModels(baseURL, log, apiKey, force = false, suppress) {
  if (!force && lastRefresh && Date.now() - lastRefresh.at < REFRESH_TTL_MS) {
    log.info(`Using in-memory plexus model cache (${lastRefresh.models.length} models)`);
    return Promise.resolve(lastRefresh.models);
  }
  if (inFlightRefresh)
    return inFlightRefresh;
  const run = async () => {
    const url = modelsUrl(baseURL);
    const cached = await readCachedModels(suppress);
    const { models: apiModels, raw, etag, notModified } = await fetchPlexusModels(apiKey ?? "", url, MODELS_FETCH_TIMEOUT_MS, cached?.etag);
    if (notModified && cached?.models) {
      log.info(`Plexus models not modified (etag: ${cached.etag})`);
      lastRefresh = { at: Date.now(), models: cached.models };
      return cached.models;
    }
    const built = buildModels(apiModels, apiBase(baseURL), suppress);
    log.info(`Fetched ${built.length} plexus models from ${baseURL}`);
    lastRefresh = { at: Date.now(), models: built };
    writeCache(built, raw, etag).catch(() => {});
    return built;
  };
  inFlightRefresh = run().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}
async function loadSource(ctx, log, options, force) {
  const suppress = getSuppressedModels(options);
  const { connection, credential } = await resolveConnectionCredential(ctx, log);
  const { baseURL, apiKey } = resolveConfig(options, credential);
  log.info(`Resolved plexus config: baseURL=${baseURL ?? "(missing)"} apiKey=${apiKey ? "present" : "missing"}`);
  if (!baseURL) {
    log.info("Plexus baseURL not configured; using cache or placeholder");
    const cached = await readCachedModels(suppress);
    if (cached && cached.models.length > 0) {
      log.info(`Loaded plexus cache with ${cached.models.length} models`);
      return { models: cached.models, baseURL, apiKey, connection };
    }
    return { models: [placeholderModel()], baseURL, apiKey, connection };
  }
  try {
    const models = await refreshModels(baseURL, log, apiKey, force, suppress);
    if (models.length === 0) {
      log.warn("Live fetch returned no models; falling back to cache or placeholder");
      const cached = await readCachedModels(suppress);
      return {
        models: cached && cached.models.length > 0 ? cached.models : [placeholderModel()],
        baseURL,
        apiKey,
        connection
      };
    }
    return { models, baseURL, apiKey, connection };
  } catch (e) {
    log.warn(`Live plexus refresh failed, using cache: ${String(e)}`);
    const cached = await readCachedModels(suppress);
    if (cached && cached.models.length > 0) {
      return { models: cached.models, baseURL, apiKey, connection };
    }
    return { models: [placeholderModel()], baseURL, apiKey, connection };
  }
}
function providerInfo(source) {
  const providerID = Provider.ID.make(PLEXUS_PROVIDER_ID);
  const info = {
    ...Provider.Info.empty(providerID),
    name: PLEXUS_PROVIDER_NAME,
    activation: "enabled",
    package: OPENAI_COMPATIBLE_PKG,
    integrationID: PLEXUS_INTEGRATION_ID,
    settings: {
      ...source.baseURL ? { baseURL: apiBase(source.baseURL) } : {},
      ...source.apiKey ? { apiKey: source.apiKey } : {}
    }
  };
  return info;
}
var plugin_default = Plugin.define({
  id: PLEXUS_PLUGIN_ID,
  async setup(ctx) {
    const log = createLogger();
    const options = ctx.options ?? {};
    const source = { models: [], baseURL: undefined, apiKey: undefined, connection: undefined };
    const reloadSource = async (force) => {
      const next = await loadSource(ctx, log, options, force);
      source.models = next.models;
      source.baseURL = next.baseURL;
      source.apiKey = next.apiKey;
      source.connection = next.connection;
    };
    await reloadSource(false);
    const providerID = Provider.ID.make(PLEXUS_PROVIDER_ID);
    await ctx.provider.transform((editor) => {
      const existing = editor.get(providerID);
      if (existing)
        editor.remove(providerID);
      editor.add({
        info: providerInfo(source),
        models: toModelInfo(source.models),
        ...source.connection ? { sourceConnection: source.connection } : {}
      });
      log.info(`Provider transform: registered ${PLEXUS_PROVIDER_ID} with ${source.models.length} models (present=${Boolean(editor.get(providerID))})`);
    });
    await ctx.provider.transform((editor) => {
      editor.update(providerID, (provider) => {
        const settings = provider.settings ?? {};
        if (source.baseURL)
          settings["baseURL"] = apiBase(source.baseURL);
        else
          delete settings["baseURL"];
        if (source.apiKey)
          settings["apiKey"] = source.apiKey;
        else
          delete settings["apiKey"];
        provider.settings = settings;
      });
    });
    try {
      await ctx.integration.transform((editor) => {
        editor.update(PLEXUS_INTEGRATION_ID, (ref) => {
          ref.name = PLEXUS_PROVIDER_NAME;
        });
        editor.method.update({
          integrationID: PLEXUS_INTEGRATION_ID,
          method: {
            type: "key",
            label: "Plexus API key",
            form: [
              {
                type: "string",
                key: PLEXUS_BASE_URL_OPTION,
                title: "Plexus base URL",
                description: "Plexus root URL (https://host or https://host/v1)",
                placeholder: "https://plexus.example.com",
                required: true
              }
            ]
          }
        });
      });
    } catch (e) {
      log.warn(`Integration transform failed (non-fatal): ${String(e)}`);
    }
    await ctx.command.transform((editor) => {
      editor.add({
        name: PLEXUS_REFRESH_COMMAND,
        description: "Refresh Plexus models from the live server",
        execute: async ({ sessionID, delivery }) => {
          lastRefresh = null;
          await reloadSource(true);
          await ctx.provider.reload();
          const count = source.models.length;
          const placeholderOnly = count === 1 && source.models[0]?.id === PLACEHOLDER_MODEL_ID;
          const text = !source.baseURL ? "Plexus refresh failed: no base URL configured. Run /connect first (plexus integration)." : placeholderOnly ? `Plexus refresh from ${source.baseURL} returned no usable models. Existing state left untouched.` : `Plexus models refreshed: ${count} models from ${source.baseURL}.`;
          log.info(text);
          await ctx.session.synthetic({
            sessionID,
            text,
            description: text,
            delivery,
            resume: false
          });
        }
      });
    });
    (async () => {
      let pending = null;
      for await (const event of ctx.event.subscribe()) {
        const type = event.type;
        if (type !== "credential.updated" && type !== "credential.switched")
          continue;
        if (pending)
          continue;
        pending = (async () => {
          try {
            lastRefresh = null;
            await reloadSource(true);
            await ctx.provider.reload();
            log.info(`Credentials changed (${type}); reloaded ${source.models.length} model(s)`);
          } catch (e) {
            log.warn(`Reload after credential change failed: ${String(e)}`);
          } finally {
            pending = null;
          }
        })();
      }
    })().catch((e) => log.warn(`Credential watcher stopped: ${String(e)}`));
    log.info(`Plexus V2 plugin ready: ${source.models.length} model(s)${source.baseURL ? ` from ${source.baseURL}` : " (unconfigured)"}`);
  }
});

// src/index.ts
var src_default = plugin_default;
export {
  ANTHROPIC_PKG,
  CACHE_VERSION,
  ENV_API_KEY,
  ENV_API_URL,
  ENV_BASE_URL,
  GOOGLE_PKG,
  MODELS_FETCH_TIMEOUT_MS,
  OPENAI_COMPATIBLE_PKG,
  OPENAI_RESPONSES_PKG,
  PLACEHOLDER_MODEL_ID,
  PLEXUS_BASE_URL_OPTION,
  PLEXUS_INTEGRATION_ID,
  PLEXUS_PLUGIN_ID,
  PLEXUS_PROVIDER_ID,
  PLEXUS_PROVIDER_NAME,
  PLEXUS_REFRESH_COMMAND,
  PLEXUS_SUPPRESS_MODELS_OPTION,
  REFRESH_TTL_MS,
  apiBase,
  buildModels,
  src_default as default,
  filterCachedModels,
  getDir,
  getSuppressedModels,
  modelsUrl,
  orderModelsByApiBase,
  placeholderModel,
  readCachedModels,
  resolveConfig,
  resolveConfigTemplate,
  rootURL,
  trimURL,
  writeCache
};
