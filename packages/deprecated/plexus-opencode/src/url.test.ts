import { describe, expect, test } from "bun:test"
import { apiBase, modelsUrl, rootURL } from "./url.ts"

describe("Plexus URL helpers", () => {
  test("normalizes root URL inputs for storage", () => {
    expect(rootURL("https://plexus.example.com")).toBe("https://plexus.example.com")
    expect(rootURL("https://plexus.example.com/")).toBe("https://plexus.example.com")
    expect(rootURL("https://plexus.example.com/v1")).toBe("https://plexus.example.com")
    expect(rootURL("https://plexus.example.com/v1/")).toBe("https://plexus.example.com")
  })

  test("normalizes root or /v1 inputs to the API base", () => {
    expect(apiBase("https://plexus.example.com")).toBe("https://plexus.example.com/v1")
    expect(apiBase("https://plexus.example.com/v1")).toBe("https://plexus.example.com/v1")
  })

  test("builds models URL from root or /v1 inputs", () => {
    expect(modelsUrl("https://plexus.example.com")).toBe("https://plexus.example.com/v1/models")
    expect(modelsUrl("https://plexus.example.com/v1")).toBe("https://plexus.example.com/v1/models")
  })
})
