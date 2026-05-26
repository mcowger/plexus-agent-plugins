/**
 * Bundles src/extension.ts + plexus-models into a single dist/extension.js
 * that the OMP legacy-pi shim can load without needing to resolve bare specifiers.
 *
 * Run: bun run build.ts
 */
import * as path from "node:path";

const result = await Bun.build({
	entrypoints: [path.join(import.meta.dir, "src/extension.ts")],
	outdir: path.join(import.meta.dir, "dist"),
	target: "bun",
	format: "esm",
	// Bundle plexus-models in; keep @earendil-works/* external so the legacy
	// shim can remap them to OMP's bundled copies at load time.
	external: [
		"@earendil-works/pi-ai",
		"@earendil-works/pi-coding-agent",
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

console.log("Built:", result.outputs.map(o => o.path).join(", "));
