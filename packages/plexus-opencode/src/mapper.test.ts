import { describe, expect, test } from "bun:test"
import { buildModels } from "./mapper.ts"
import { toRuntimeModels } from "./plugin.ts"

describe("OpenCode model mapping", () => {
  test("uses a 250K context fallback and a 20% output fallback", () => {
    const models = buildModels([{ id: "unknown-chat-model" }], "https://plexus.example.com/v1")

    expect(models["unknown-chat-model"]?.limit).toEqual({
      context: 250_000,
      output: 50_000,
    })
  })

  test("selects the native SDK and URL for each preferred API", () => {
    const models = buildModels(
      [
        { id: "chat", preferred_api: "chat_completions" },
        { id: "responses", preferred_api: "responses" },
        { id: "claude", preferred_api: "messages" },
        { id: "gemini", preferred_api: "gemini" },
      ],
      "https://plexus.example.com/v1",
    )

    expect(models.chat?.provider).toEqual({ api: "https://plexus.example.com/v1" })
    expect(models.responses?.provider).toEqual({
      npm: "@ai-sdk/openai",
      api: "https://plexus.example.com/v1",
    })
    expect(models.claude?.provider).toEqual({
      npm: "@ai-sdk/anthropic",
      api: "https://plexus.example.com",
    })
    expect(models.gemini?.provider).toEqual({
      npm: "@ai-sdk/google",
      api: "https://plexus.example.com/v1beta",
    })
  })

  test("preserves model identity and quirk metadata for OpenCode native transforms", () => {
    const mapped = buildModels(
      [{
        id: "deepseek-reasoner",
        created: 1_735_689_600,
        preferred_api: "openai-completions",
        supported_parameters: ["reasoning"],
      }],
      "https://plexus.example.com/v1",
    )
    const runtime = toRuntimeModels(mapped, {
      id: "plexus",
      name: "Plexus",
      source: "custom",
      env: [],
      options: {},
      models: {},
    })
    const model = runtime["deepseek-reasoner"]

    expect(model?.api.id).toBe("deepseek-reasoner")
    expect(model?.api.npm).toBe("@ai-sdk/openai-compatible")
    expect(model?.release_date).toBe("2025-01-01")
    expect(model?.capabilities.interleaved).toEqual({ field: "reasoning_content" })
    expect(model?.variants).toBeUndefined()
  })
})

describe("OpenCode pricing mapping", () => {
  test("converts per-token base and tier rates to per-million pricing", () => {
    const models = buildModels(
      [
        {
          id: "claude-alias",
          pricing: {
            prompt: "0.000005",
            completion: "0.000030",
            input_cache_read: "0.0000005",
            input_cache_write: "0.00000625",
            tiers: [
              {
                input_tokens_above: 272_000,
                prompt: "0.000010",
                completion: "0.000045",
                input_cache_read: "0.000001",
                input_cache_write: "0.0000125",
              },
            ],
          },
        },
      ],
      "https://plexus.example.com/v1",
    )

    expect(models["claude-alias"]?.cost).toEqual({
      input: 5,
      output: 30,
      cache_read: 0.5,
      cache_write: 6.25,
    })
    expect(models["claude-alias"]?.pricingTiers).toEqual([
      {
        inputTokensAbove: 272_000,
        input: 10,
        output: 45,
        cacheRead: 1,
        cacheWrite: 12.5,
      },
    ])
  })
})
