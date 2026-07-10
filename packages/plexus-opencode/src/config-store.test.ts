import { afterEach, describe, expect, test } from "bun:test"
import { PLEXUS_BASE_URL_OPTION } from "./constants.ts"
import { AUTH_METADATA_BASE_URL, resolveConfig, resolveConfigTemplate } from "./config-store.ts"

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("OpenCode config resolution", () => {
  test("resolves pi-style environment templates", () => {
    process.env["PLEXUS_TEST_HOST"] = "https://plexus.example.com"
    process.env["PLEXUS_TEST_KEY"] = "secret"

    expect(resolveConfigTemplate("${PLEXUS_TEST_HOST}/v1")).toBe("https://plexus.example.com/v1")
    expect(resolveConfigTemplate("$PLEXUS_TEST_KEY")).toBe("secret")
    expect(resolveConfigTemplate("cost-$$5")).toBe("cost-$5")
  })

  test("respects PLEXUS_API_URL before PLEXUS_BASE_URL", () => {
    process.env["PLEXUS_BASE_URL"] = "https://base.example.com/v1"
    process.env["PLEXUS_API_URL"] = "https://api.example.com/v1"

    expect(resolveConfig()).toMatchObject({ baseURL: "https://api.example.com" })
  })

  test("resolves configured URL and key templates", () => {
    process.env["PLEXUS_CONFIG_URL"] = "https://configured.example.com/v1"
    process.env["PLEXUS_CONFIG_KEY"] = "configured-secret"

    expect(
      resolveConfig({
        options: {
          [PLEXUS_BASE_URL_OPTION]: "${PLEXUS_CONFIG_URL}",
          apiKey: "${PLEXUS_CONFIG_KEY}",
        },
      } as never),
    ).toEqual({
      baseURL: "https://configured.example.com",
      apiKey: "configured-secret",
    })
  })

  test("uses auth metadata before provider config", () => {
    expect(
      resolveConfig(
        {
          options: {
            [PLEXUS_BASE_URL_OPTION]: "https://configured.example.com/v1",
          },
        } as never,
        { [AUTH_METADATA_BASE_URL]: "https://metadata.example.com/v1" },
      ),
    ).toMatchObject({ baseURL: "https://metadata.example.com" })
  })
})
