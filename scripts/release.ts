#!/usr/bin/env bun
/**
 * Cuts a release: bumps version, commits, tags, pushes.
 * The publish workflow triggers on the pushed tag.
 *
 * Usage:
 *   bun scripts/release.ts 1.2.3
 */

import { $ } from "bun";

const version = process.argv[2];

if (!version) {
	console.error("Usage: bun scripts/release.ts <version>");
	process.exit(1);
}

if (!/^\d+\.\d+\.\d+$/.test(version)) {
	console.error(`Invalid version: "${version}". Must be semver (e.g. 1.2.3)`);
	process.exit(1);
}

// Ensure working tree is clean
const status = await $`git status --porcelain`.text();
if (status.trim()) {
	console.error("Working tree is not clean. Commit or stash changes first.");
	process.exit(1);
}

// Ensure we're on main
const branch = (await $`git rev-parse --abbrev-ref HEAD`.text()).trim();
if (branch !== "main") {
	console.error(`Must be on main branch (currently on "${branch}")`);
	process.exit(1);
}

// Pull latest
await $`git pull --ff-only origin main`;

const tag = `v${version}`;

// Check tag doesn't already exist
const existingTag = await $`git tag -l ${tag}`.text();
if (existingTag.trim()) {
	console.error(`Tag ${tag} already exists`);
	process.exit(1);
}

// Sync version into all package.json files
await $`bun scripts/sync-versions.ts ${version}`;

// Commit
await $`git add packages/plexus-pi/package.json package.json`;
await $`git commit -m "Release ${tag}"`;

// Tag
await $`git tag -a ${tag} -m "Release ${tag}"`;

// Push commit + tag together
await $`git push origin main ${tag}`;

console.log(`\nReleased ${tag} — publish workflow triggered.`);
