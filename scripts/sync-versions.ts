#!/usr/bin/env bun
/**
 * Syncs the root package.json version to all published workspace packages.
 *
 * Usage:
 *   bun scripts/sync-versions.ts           -- sync from root version
 *   bun scripts/sync-versions.ts 1.2.3     -- set root to 1.2.3 then sync
 */

import { join } from "node:path";

const root = import.meta.dir.replace(/\/scripts$/, "");

// Only packages that are published to npm.
// plexus-models is a build-time internal dep (bundled into host packages) — not published.
const PACKAGES = [
	"packages/plexus-pi",
	"packages/plexus-opencode",
	"packages/plexus-oh-my-pi",
];

const readJson = async (path: string) => JSON.parse(await Bun.file(path).text());
const writeJson = async (path: string, obj: unknown) =>
	Bun.write(path, JSON.stringify(obj, null, "\t") + "\n");

const rootPkgPath = join(root, "package.json");
const rootPkg = await readJson(rootPkgPath);

const newVersion = process.argv[2];
if (newVersion) {
	if (!/^\d+\.\d+\.\d+/.test(newVersion)) {
		console.error(`Invalid version: ${newVersion}`);
		process.exit(1);
	}
	rootPkg.version = newVersion;
	await writeJson(rootPkgPath, rootPkg);
	console.log(`Root version set to ${newVersion}`);
}

const version: string = rootPkg.version;
if (!version) {
	console.error("No version found in root package.json");
	process.exit(1);
}

for (const pkgDir of PACKAGES) {
	const pkgPath = join(root, pkgDir, "package.json");
	const pkg = await readJson(pkgPath);
	pkg.version = version;
	await writeJson(pkgPath, pkg);
	console.log(`${pkg.name} -> ${version}`);
}

console.log(`\nAll packages synced to ${version}`);
