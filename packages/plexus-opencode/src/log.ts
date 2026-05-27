import type { PluginInput } from "@opencode-ai/plugin"
import { PLEXUS_LOG_SERVICE } from "./constants.ts"

export interface Logger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/**
 * Create a logger that wraps ctx.client.app.log().
 * All failures are swallowed — logging must never break the plugin.
 */
export function createLogger(client: PluginInput["client"]): Logger {
  function log(level: "info" | "warn" | "error", message: string): void {
    client.app.log({ body: { service: PLEXUS_LOG_SERVICE, level, message } }).catch(() => {})
  }

  return {
    info: (message) => log("info", message),
    warn: (message) => log("warn", message),
    error: (message) => log("error", message),
  }
}
