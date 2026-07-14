/**
 * Bundles src/extension.ts + plexus-models into a single dist/extension.js
 * for npm publishing. Not needed for development — Oh My Pi loads
 * src/extension.ts directly via jiti when installed from source (git clone
 * or path).
 *
 * Run: bun run build.ts
 */
import * as path from "node:path";

const result = await Bun.build({
	entrypoints: [path.join(import.meta.dir, "src/extension.ts")],
	outdir: path.join(import.meta.dir, "dist"),
	target: "bun",
	format: "esm",
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
	// @oh-my-pi/swarm-extension.
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
