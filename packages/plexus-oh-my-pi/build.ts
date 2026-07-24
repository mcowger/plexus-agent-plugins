/**
 * Bundles src/extension.ts + plexus-models into a single dist/extension.js
 * for npm publishing. Not needed for development — Oh My Pi loads
 * src/extension.ts directly via jiti when installed from source (git clone
 * or path).
 *
 * Run: bun run build.ts
 */
import * as path from "node:path";

// pi-catalog is bundled inline (see below), but it transitively imports
// @oh-my-pi/pi-utils/logger (used for a single non-essential warn() call in
// openai-compat.ts's LiteLLM metadata fallback), which pulls in winston. Oh
// My Pi's legacy-pi compat shim only has a working virtual-module remap for
// a handful of @oh-my-pi/* package *roots* (pi-ai, pi-coding-agent, pi-tui);
// deep subpaths like pi-utils/logger fall through to a real filesystem
// resolve that can't find winston, producing "Cannot find package 'winston'"
// at load time. Replace the logger subpath with a no-op stub at build time so
// it never appears in the bundle and never triggers that broken resolution.
const stubPiUtilsLogger: Bun.BunPlugin = {
	name: "stub-pi-utils-logger",
	setup(build) {
		const STUB_NAMESPACE = "stub-pi-utils-logger";
		build.onResolve({ filter: /^@oh-my-pi\/pi-utils\/logger$/ }, (args) => ({
			path: args.path,
			namespace: STUB_NAMESPACE,
		}));
		build.onLoad({ filter: /.*/, namespace: STUB_NAMESPACE }, () => ({
			contents: "export function warn(){}\nexport function debug(){}\nexport function info(){}\nexport function error(){}\n",
			loader: "js",
		}));
	},
};

const result = await Bun.build({
	entrypoints: [path.join(import.meta.dir, "src/extension.ts")],
	outdir: path.join(import.meta.dir, "dist"),
	target: "bun",
	format: "esm",
	plugins: [stubPiUtilsLogger],
	// Bundle plexus-models inline; keep @oh-my-pi/* and node:* external so
	// Oh My Pi's extension loader resolves them against its own bundled copies
	// at load time.
	// Bundle plexus-models + @oh-my-pi/pi-catalog inline (pi-catalog is only
	// used at build time for getBundledModel(); its dependency graph, notably
	// arktype, breaks Oh My Pi's extension-graph loader if left as a bare
	// runtime import — see legacy-pi-compat.ts's collectExtensionModules,
	// which mis-hooks arktype's internal @ark/schema resolution when it
	// walks into a bare-imported package's unbundled source tree). Keep
	// @oh-my-pi/pi-ai and @oh-my-pi/pi-coding-agent external since they're
	// only used for types (erased below); @oh-my-pi/pi-utils is a real,
	// lightweight runtime dependency the host always provides, same as
	// @oh-my-pi/swarm-extension. Its /logger subpath is stubbed above instead
	// of left external — see stubPiUtilsLogger.
	external: ["@oh-my-pi/pi-ai", "@oh-my-pi/pi-ai/*", "@oh-my-pi/pi-coding-agent", "@oh-my-pi/pi-utils", "node:*"],
	naming: "extension.js",
	minify: false,
});

if (!result.success) {
	for (const log of result.logs) {
		console.error(log);
	}
	process.exit(1);
}

console.log("Built:", result.outputs.map((o) => o.path).join(", "));
