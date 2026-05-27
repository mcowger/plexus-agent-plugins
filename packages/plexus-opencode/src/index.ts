import type { PluginModule } from "@opencode-ai/plugin"
import { PLEXUS_PLUGIN_ID } from "./constants.ts"
import { PlexusProviderPlugin } from "./plugin.ts"

export * from "./constants.ts"
export * from "./mapper.ts"
export * from "./plugin.ts"

const plugin: PluginModule = {
  id: PLEXUS_PLUGIN_ID,
  server: PlexusProviderPlugin,
}

export default plugin
