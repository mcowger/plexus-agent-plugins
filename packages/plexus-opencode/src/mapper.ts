import { adjustBaseUrl, mapPreferredApi, type PlexusApiModel } from "../../plexus-models/src/index.ts"

type Modality = "text" | "audio" | "image" | "video" | "pdf"

/** Subset of ProviderConfig.models value that OpenCode expects. */
export interface ConfigModel {
  id: string
  name: string
  provider?: {
    npm?: string
    api?: string
  }
  attachment?: boolean
  reasoning?: boolean
  temperature?: boolean
  tool_call?: boolean
  cost?: {
    input: number
    output: number
    cache_read?: number
    cache_write?: number
  }
  limit: {
    context: number
    output: number
  }
  modalities: {
    input: Modality[]
    output: Modality[]
  }
}

const REASONING_PARAMS = new Set(["reasoning", "include_reasoning", "reasoning_effort"])
const DEFAULT_CONTEXT = 8192

function resolveModelProvider(
  model: PlexusApiModel,
  baseURL: string,
): { npm?: string; api?: string } {
  const preferredApi = mapPreferredApi(model.preferred_api)
  const api = adjustBaseUrl(baseURL, preferredApi)

  switch (preferredApi) {
    case "anthropic-messages":
      return { npm: "@ai-sdk/anthropic", api }
    case "google-generative-ai":
      return { npm: "@ai-sdk/google", api }
    case "openai-responses":
      return { npm: "@ai-sdk/openai", api }
    case "openai-completions":
      return { api }
    default:
      return { api }
  }
}

function parsePrice(value: string | undefined): number {
  if (!value) return 0
  const n = parseFloat(value)
  return Number.isNaN(n) ? 0 : n
}

/**
 * Map a single Plexus modality string to an OpenCode Modality string.
 * "file" → "pdf"; unknown strings are dropped.
 */
function mapModality(m: string): Modality | null {
  switch (m) {
    case "text": return "text"
    case "image": return "image"
    case "audio": return "audio"
    case "video": return "video"
    case "file":
    case "pdf": return "pdf"
    default: return null
  }
}

function buildInputModalities(model: PlexusApiModel): Modality[] {
  const raw = model.architecture?.input_modalities ?? []
  const mapped = raw.map(mapModality).filter((m): m is Modality => m !== null)
  return mapped.length > 0 ? [...new Set(mapped)] : ["text"]
}

// Patterns that identify non-chat models when no architecture metadata is present.
const NON_CHAT_ID_PATTERN =
  /embedding|embed|tts|whisper|image-[0-9]|image\b.*gen|diffusion|dall-e|stable-diff|sdxl|dream/i

function buildOutputModalities(model: PlexusApiModel): Modality[] | null {
  const raw = model.architecture?.output_modalities

  if (raw !== undefined) {
    // Architecture is present — require text output.
    if (!raw.includes("text")) return null
    const mapped = raw.map(mapModality).filter((m): m is Modality => m !== null)
    return mapped.length > 0 ? [...new Set(mapped)] : ["text"]
  }

  // No architecture — use id heuristics.
  if (NON_CHAT_ID_PATTERN.test(model.id)) return null

  return ["text"]
}

/**
 * Transform a list of PlexusApiModel objects into the dict of ConfigModel
 * objects expected by OpenCode's cfg.provider.plexus.models.
 *
 * Image-output and embedding models are filtered out — OpenCode does not
 * support non-chat models as chat providers.
 */
export function buildModels(models: PlexusApiModel[], baseURL: string): Record<string, ConfigModel> {
  const result: Record<string, ConfigModel> = {}

  for (const m of models) {
    if (!m.id) continue

    const outputModalities = buildOutputModalities(m)
    if (outputModalities === null) continue

    const inputModalities = buildInputModalities(m)
    const params = m.supported_parameters ?? []

    const contextLength =
      (typeof m.context_length === "number" && m.context_length > 0 ? m.context_length : undefined) ??
      (typeof m.top_provider?.context_length === "number" && m.top_provider.context_length > 0
        ? m.top_provider.context_length
        : undefined) ??
      DEFAULT_CONTEXT

    const maxOutput =
      (typeof m.top_provider?.max_completion_tokens === "number" &&
      m.top_provider.max_completion_tokens > 0
        ? m.top_provider.max_completion_tokens
        : undefined) ?? Math.ceil(contextLength * 0.2)

    const promptPrice = parsePrice(m.pricing?.prompt)
    const completionPrice = parsePrice(m.pricing?.completion)
    const cacheReadPrice = parsePrice(m.pricing?.input_cache_read)
    const cacheWritePrice = parsePrice(m.pricing?.input_cache_write)
    const hasCachePricing = cacheReadPrice > 0 || cacheWritePrice > 0

    const hasNonTextInput = inputModalities.some((mod) => mod !== "text")
    const provider = resolveModelProvider(m, baseURL)

    const entry: ConfigModel = {
      id: m.id,
      name: m.name ?? m.id,
      provider,
      limit: {
        context: contextLength,
        output: maxOutput,
      },
      modalities: {
        input: inputModalities,
        output: outputModalities,
      },
      ...(promptPrice > 0 || completionPrice > 0
        ? {
            cost: {
              input: promptPrice,
              output: completionPrice,
              ...(hasCachePricing
                ? { cache_read: cacheReadPrice, cache_write: cacheWritePrice }
                : {}),
            },
          }
        : {}),
      ...(params.includes("tools") ? { tool_call: true } : {}),
      ...(params.some((p) => REASONING_PARAMS.has(p)) ? { reasoning: true } : {}),
      ...(params.includes("temperature") ? { temperature: true } : {}),
      ...(hasNonTextInput ? { attachment: true } : {}),
    }

    result[m.id] = entry
  }

  return result
}
