import { describe, expect, test } from "bun:test"
import { filterCachedModels } from "./cache.ts"
import type { ConfigModel } from "./mapper.ts"

function cachedModel(id: string, name = id): ConfigModel {
  return {
    id,
    name,
    limit: { context: 8192, output: 4096 },
    modalities: { input: ["text"], output: ["text"] },
  }
}

describe("OpenCode model cache", () => {
  test("removes non-chat entries written by older plugin versions", () => {
    const models = filterCachedModels({
      chat: cachedModel("chat"),
      whisper: {
        ...cachedModel("whisper-large-v3", "Whisper 3 Large"),
        modalities: { input: ["audio"], output: ["text"] },
      },
      transcription: {
        ...cachedModel("gpt-4o-transcribe"),
        modalities: { input: ["audio"], output: ["text"] },
      },
      embedding: cachedModel("text-embedding-3-small"),
    })

    expect(Object.keys(models)).toEqual(["chat"])
  })

  test("removes suppressed model entries from cache", () => {
    const models = filterCachedModels(
      {
        "gpt-4o": cachedModel("gpt-4o"),
        "gpt-3.5-turbo": cachedModel("gpt-3.5-turbo"),
      },
      "gpt-3.5*",
    )

    expect(Object.keys(models)).toEqual(["gpt-4o"])
  })

  test("filters suppressed models from cache", () => {
    const models = filterCachedModels(
      {
        gpt4: cachedModel("gpt-4o"),
        gpt35: cachedModel("gpt-3.5-turbo"),
      },
      ["gpt-3.5*"],
    )

    expect(Object.keys(models)).toEqual(["gpt4"])
  })
})
