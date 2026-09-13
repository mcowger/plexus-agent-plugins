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
    // Anthropic models expose the versioned base used by OpenCode's AI SDK.
    // In OpenCode's runtime, /v1 is the first published model so clients that
    // inspect only the first runtime model use /v1/chat/completions.
    expect(models.claude?.provider).toEqual({
      npm: "@ai-sdk/anthropic",
      api: "https://plexus.example.com/v1",
    })
    expect(models.gemini?.provider).toEqual({
      npm: "@ai-sdk/google",
      api: "https://plexus.example.com/v1beta",
    })
    expect(Object.keys(models)[0]).toBe("chat")
  })

  test("publishes /v1 models before /v1beta models without changing endpoints", () => {
    const models = buildModels(
      [
        { id: "gemini-first", preferred_api: "gemini" },
        { id: "chat-second", preferred_api: "chat_completions" },
        { id: "claude-third", preferred_api: "messages" },
        { id: "gemini-fourth", preferred_api: "gemini" },
        { id: "responses-fifth", preferred_api: "responses" },
      ],
      "https://plexus.example.com/v1",
    )

    expect(Object.keys(models)).toEqual([
      "chat-second",
      "claude-third",
      "responses-fifth",
      "gemini-first",
      "gemini-fourth",
    ])
    expect(models["chat-second"]?.provider?.api).toBe("https://plexus.example.com/v1")
    expect(models["claude-third"]?.provider).toEqual({
      npm: "@ai-sdk/anthropic",
      api: "https://plexus.example.com/v1",
    })
    expect(models["responses-fifth"]?.provider).toEqual({
      npm: "@ai-sdk/openai",
      api: "https://plexus.example.com/v1",
    })
    expect(models["gemini-first"]?.provider).toEqual({
      npm: "@ai-sdk/google",
      api: "https://plexus.example.com/v1beta",
    })

    const runtime = toRuntimeModels(models, {
      id: "plexus",
      name: "Plexus",
      source: "custom",
      env: [],
      options: {},
      models: {},
    })

    expect(Object.keys(runtime)[0]).toBe("chat-second")
    expect(runtime["chat-second"]?.api.url).toBe("https://plexus.example.com/v1")
    expect(runtime["gemini-first"]?.api).toMatchObject({
      url: "https://plexus.example.com/v1beta",
      npm: "@ai-sdk/google",
    })
  })

  test("orders runtime models while retaining capabilities metadata", () => {
    const mapped = buildModels(
      [
        { id: "gemini-first", preferred_api: "gemini" },
        { id: "chat-second", preferred_api: "chat_completions" },
      ],
      "https://plexus.example.com/v1",
    )
    // Simulate an unordered old cache by restoring server order before the
    // runtime conversion.
    const unordered = {
      "gemini-first": mapped["gemini-first"]!,
      "chat-second": mapped["chat-second"]!,
    }
    const runtime = toRuntimeModels(unordered, {
      id: "plexus",
      name: "Plexus",
      source: "custom",
      env: [],
      options: {},
      models: {},
    })

    expect(Object.keys(runtime)).toEqual(["chat-second", "gemini-first"])
    expect(runtime["chat-second"]?.capabilities.input.text).toBe(true)
    expect(runtime["gemini-first"]?.api.url).toBe("https://plexus.example.com/v1beta")
  })

  test("filters embedding and transcription endpoint models", () => {
    const models = buildModels(
      [
        { id: "chat-model" },
        { id: "text-embedding-3-small" },
        { id: "whisper-large-v3" },
        { id: "opaque-transcriber", preferred_api: "audio_transcriptions" },
        {
          id: "gpt-4o-mini",
          name: "GPT-4o mini Transcribe",
        },
      ],
      "https://plexus.example.com/v1",
    )

    expect(Object.keys(models)).toEqual(["chat-model"])
  })

  test("suppresses models matching suppression patterns", () => {
    const models = buildModels(
      [
        { id: "gpt-4o" },
        { id: "gpt-3.5-turbo" },
        { id: "claude-2.0" },
      ],
      "https://plexus.example.com/v1",
      ["gpt-3.5*", "claude-2*"],
    )

    expect(Object.keys(models)).toEqual(["gpt-4o"])
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

  test("maps Plexus reasoning efforts to OpenCode variants", () => {
    const mapped = buildModels(
      [{
        id: "gpt-5.6-luna",
        preferred_api: "responses",
        supported_parameters: ["reasoning"],
        reasoning_options: [{
          type: "effort",
          values: ["off", "low", "medium", "high", "xhigh", "max"],
        }],
      }],
      "https://plexus.example.com/v1",
    )

    expect(mapped["gpt-5.6-luna"]?.variants).toEqual({
      none: { reasoningEffort: "none" },
      low: { reasoningEffort: "low" },
      medium: { reasoningEffort: "medium" },
      high: { reasoningEffort: "high" },
      xhigh: { reasoningEffort: "xhigh" },
      max: { reasoningEffort: "max" },
    })

    const runtime = toRuntimeModels(mapped, {
      id: "plexus",
      name: "Plexus",
      source: "custom",
      env: [],
      options: {},
      models: {},
    })
    expect(runtime["gpt-5.6-luna"]?.variants).toEqual(mapped["gpt-5.6-luna"]?.variants)
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
