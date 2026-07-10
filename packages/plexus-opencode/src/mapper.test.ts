import { describe, expect, test } from "bun:test"
import { buildModels } from "./mapper.ts"

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
