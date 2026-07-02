import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { ConfigModel } from "./mapper.ts"
import type { PlexusApiResponse } from "../../plexus-models/src/index.ts"

const PLUGIN_SUBDIR = join("plugins", "plexus")
const CACHE_FILE = "models-cache.json"
const RAW_FILE = "models-raw.json"

/** Default fallback path that doesn't require an API call. */
function fallbackDir(): string {
  return join(homedir(), ".local", "share", "opencode", PLUGIN_SUBDIR)
}

/**
 * Resolve the cache directory.
 *
 * IMPORTANT: this must NOT call back into the OpenCode server (e.g.
 * client.path.get()) — the config() hook runs as part of the server's own
 * bootstrap/config-loading sequence, before the server is necessarily ready
 * to service its own HTTP routes. Making an HTTP round-trip back to the
 * server from inside config() can deadlock startup indefinitely (observed:
 * client.path.get() never resolves and never rejects). Always use the plain
 * homedir path instead.
 */
function getDir(): string {
  return fallbackDir()
}

interface ModelCache {
  models: Record<string, ConfigModel>
  timestamp: number
}

// ---------------------------------------------------------------------------
// Async helpers (homedir-resolved path, used after await)
// ---------------------------------------------------------------------------

/**
 * Read cached models asynchronously.
 *
 * The `client` parameter is unused (kept for call-site compatibility) —
 * resolving the cache dir must never call back into the OpenCode server; see
 * getDir() for why.
 */
export async function readCachedModels(
  _client: PluginInput["client"],
): Promise<Record<string, ConfigModel> | null> {
  try {
    const dir = getDir()
    const content = await readFile(join(dir, CACHE_FILE), "utf8")
    const parsed = JSON.parse(content) as ModelCache
    if (parsed && typeof parsed.models === "object" && !Array.isArray(parsed.models)) {
      return parsed.models
    }
    return null
  } catch {
    return null
  }
}

/**
 * Write the model cache and (optionally) raw API response to disk. Never throws.
 *
 * The `client` parameter is unused (kept for call-site compatibility) — see
 * getDir() for why cache dir resolution must stay purely local.
 */
export async function writeCache(
  _client: PluginInput["client"],
  models: Record<string, ConfigModel>,
  raw?: PlexusApiResponse,
): Promise<void> {
  try {
    const dir = getDir()
    await mkdir(dir, { recursive: true })

    const cache: ModelCache = { models, timestamp: Date.now() }
    await writeFile(join(dir, CACHE_FILE), JSON.stringify(cache, null, 2) + "\n", "utf8")

    if (raw !== undefined) {
      await writeFile(join(dir, RAW_FILE), JSON.stringify(raw, null, 2) + "\n", "utf8")
    }
  } catch {
    // Never block plugin init on cache write failures
  }
}
