import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import type { ConfigModel } from "./mapper.ts"
import type { PlexusApiResponse } from "../../plexus-models/src/index.ts"

const PLUGIN_SUBDIR = join("plugins", "plexus")
const CACHE_FILE = "models-cache.json"
const RAW_FILE = "models-raw.json"

/** Resolved once per process, then cached. */
let resolvedDir: string | null = null

/** Default fallback path that doesn't require an API call. */
function fallbackDir(): string {
  return join(homedir(), ".local", "share", "opencode", PLUGIN_SUBDIR)
}

/** Resolve the cache directory using client.path.get(), falling back to homedir. */
async function getDir(client: PluginInput["client"]): Promise<string> {
  if (resolvedDir) return resolvedDir

  try {
    const res = await client.path.get()
    const data = (res as unknown as { data?: { state?: string } | null })?.data
    const state = typeof data?.state === "string" && data.state ? data.state : undefined
    if (state) {
      resolvedDir = join(state, PLUGIN_SUBDIR)
      return resolvedDir
    }
  } catch {
    // fall through to homedir fallback
  }

  resolvedDir = fallbackDir()
  return resolvedDir
}

interface ModelCache {
  models: Record<string, ConfigModel>
  timestamp: number
}

// ---------------------------------------------------------------------------
// Sync helpers (homedir-only; used during the synchronous part of config hook)
// ---------------------------------------------------------------------------

function syncCachePath(): string {
  return join(fallbackDir(), CACHE_FILE)
}

/** Read cached models synchronously from the homedir fallback path. */
export function readCachedModelsSync(): Record<string, ConfigModel> | null {
  try {
    const path = syncCachePath()
    if (!existsSync(path)) return null
    const raw = readFileSync(path, "utf8")
    const parsed = JSON.parse(raw) as ModelCache
    if (parsed && typeof parsed.models === "object" && !Array.isArray(parsed.models)) {
      return parsed.models
    }
    return null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Async helpers (SDK-resolved path, used after await)
// ---------------------------------------------------------------------------

/** Read cached models asynchronously (uses SDK-resolved state dir). */
export async function readCachedModels(
  client: PluginInput["client"],
): Promise<Record<string, ConfigModel> | null> {
  try {
    const dir = await getDir(client)
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

/** Write the model cache and (optionally) raw API response to disk. Never throws. */
export async function writeCache(
  client: PluginInput["client"],
  models: Record<string, ConfigModel>,
  raw?: PlexusApiResponse,
): Promise<void> {
  try {
    const dir = await getDir(client)
    await mkdir(dir, { recursive: true })

    const cache: ModelCache = { models, timestamp: Date.now() }
    await writeFile(join(dir, CACHE_FILE), JSON.stringify(cache, null, 2) + "\n", "utf8")

    if (raw !== undefined) {
      await writeFile(join(dir, RAW_FILE), JSON.stringify(raw, null, 2) + "\n", "utf8")
    }

    // Mirror to homedir so the sync fallback is always fresh
    try {
      const syncDir = fallbackDir()
      mkdirSync(syncDir, { recursive: true })
      writeFileSync(join(syncDir, CACHE_FILE), JSON.stringify(cache, null, 2) + "\n", "utf8")
    } catch {
      // best-effort; never block
    }
  } catch {
    // Never block plugin init on cache write failures
  }
}
