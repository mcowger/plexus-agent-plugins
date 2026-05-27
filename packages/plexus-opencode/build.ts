/**
 * Bundles src/index.ts + plexus-models into a single dist/index.js
 * for npm publishing.
 *
 * @opencode-ai/plugin, @opencode-ai/sdk, and node:* are kept external —
 * OpenCode resolves these from its own runtime.
 *
 * Run: bun run build.ts
 */
import * as path from "node:path";

const result = await Bun.build({
	entrypoints: [path.join(import.meta.dir, "src/index.ts")],
	outdir: path.join(import.meta.dir, "dist"),
	target: "bun",
	format: "esm",
	external: [
		"@opencode-ai/plugin",
		"@opencode-ai/sdk",
		"node:*",
	],
	naming: "index.js",
	minify: false,
});

if (!result.success) {
	for (const log of result.logs) {
		console.error(log);
	}
	process.exit(1);
}

console.log("Built:", result.outputs.map((o) => o.path).join(", "));
