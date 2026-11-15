import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { resetConfigCache } from "./config.ts";
import plexusExtension from "./extension.ts";

test("refresh replaces the live catalog and rebinds the selected model", async () => {
	const dir = mkdtempSync(join(tmpdir(), "plexus-refresh-"));
	const previousDir = getAgentDir();
	const oldUrl = Bun.env.PLEXUS_API_URL;
	const oldKey = Bun.env.PLEXUS_API_KEY;
	let data = [
		{ id: "selected", context_length: 100_000 },
		{ id: "removed", context_length: 100_000 },
	];
	let fail = false;
	const server = Bun.serve({
		port: 0,
		fetch: () =>
			fail
				? new Response("unavailable", { status: 503 })
				: Response.json({ data }),
	});
	Bun.env.PLEXUS_API_URL = `http://127.0.0.1:${server.port}`;
	Bun.env.PLEXUS_API_KEY = "fixture-key";
	setAgentDir(dir);
	resetConfigCache();
	const auth = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(auth, join(dir, "models.json"));
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	let selected: Model | undefined;
	const notices: string[] = [];
	try {
		plexusExtension({
			on() {},
			registerProvider(
				name: string,
				config: Parameters<ExtensionAPI["registerProvider"]>[1],
			) {
				registry.registerProvider(name, config, "ext://plexus-refresh-test");
			},
			unregisterProvider(name: string) {
				registry.unregisterProvider(name);
			},
			registerCommand(
				_name: string,
				config: Parameters<ExtensionAPI["registerCommand"]>[1],
			) {
				command = config;
			},
			async setModel(model: Model) {
				selected = model;
				return true;
			},
		} as unknown as ExtensionAPI);
		await registry.refreshRuntimeProviders("online");
		selected = registry.find("plexus", "selected");
		expect(selected?.contextWindow).toBe(100_000);
		if (!command) throw new Error("command not registered");
		const context = {
			modelRegistry: registry,
			get model() {
				return selected;
			},
			ui: {
				notify(message: string) {
					notices.push(message);
				},
			},
		} as unknown as ExtensionCommandContext;
		data = [
			{ id: "selected", context_length: 500_000 },
			{ id: "added", context_length: 200_000 },
		];
		await command.handler("refresh", context);
		expect(registry.find("plexus", "removed")).toBeUndefined();
		expect(registry.find("plexus", "added")?.contextWindow).toBe(200_000);
		expect(registry.find("plexus", "selected")?.contextWindow).toBe(500_000);
		expect(selected?.contextWindow).toBe(500_000);
		fail = true;
		await command.handler("refresh", context);
		expect(notices.at(-1)).toContain("Refresh failed");
		expect(registry.find("plexus", "selected")?.contextWindow).toBe(500_000);
		fail = false;
		data = [];
		await command.handler("refresh", context);
		expect(registry.find("plexus", "selected")).toBeUndefined();
		expect(registry.find("plexus", "added")).toBeUndefined();
	} finally {
		server.stop(true);
		registry.clearSourceRegistrations("ext://plexus-refresh-test");
		auth.close();
		setAgentDir(previousDir);
		resetConfigCache();
		if (oldUrl === undefined) delete Bun.env.PLEXUS_API_URL;
		else Bun.env.PLEXUS_API_URL = oldUrl;
		if (oldKey === undefined) delete Bun.env.PLEXUS_API_KEY;
		else Bun.env.PLEXUS_API_KEY = oldKey;
		rmSync(dir, { recursive: true, force: true });
	}
});
