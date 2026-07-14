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
	external: [
		"@oh-my-pi/pi-ai",
		"@oh-my-pi/pi-ai/*",
		"@oh-my-pi/pi-catalog",
		"@oh-my-pi/pi-coding-agent",
		"node:*",
	],
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
