import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { resetConfigCache } from "./config.ts";
import plexusExtension from "./extension.ts";

test("refresh preserves automatic thinking in a real OMP session", async () => {
	const dir = mkdtempSync(join(tmpdir(), "plexus-refresh-auto-"));
	const previousDir = getAgentDir();
	const oldUrl = Bun.env.PLEXUS_API_URL;
	const oldKey = Bun.env.PLEXUS_API_KEY;
	let window = 100_000;
	const server = Bun.serve({
		port: 0,
		fetch: () =>
			Response.json({
				data: [
					{
						id: "thinking-model",
						context_length: window,
						supported_parameters: ["reasoning"],
					},
				],
			}),
	});
	Bun.env.PLEXUS_API_URL = `http://127.0.0.1:${server.port}`;
	Bun.env.PLEXUS_API_KEY = "fixture-key";
	setAgentDir(dir);
	resetConfigCache();
	const auth = await AuthStorage.create(":memory:");
	try {
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			authStorage: auth,
			settings: Settings.isolated({ "async.enabled": false }),
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [plexusExtension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			modelPattern: "plexus/thinking-model",
		});
		try {
			await initializeExtensions(session, {
				reportSendError: (_action, error) => {
					throw error;
				},
				reportRuntimeError: (error) => {
					throw new Error(String(error));
				},
			});
			expect(session.model?.contextWindow).toBe(100_000);
			session.setThinkingLevel("auto");
			expect(session.configuredThinkingLevel()).toBe("auto");
			const runner = session.extensionRunner;
			const command = runner?.getCommand("plexus");
			if (!runner || !command) throw new Error("Plexus command not loaded");
			window = 500_000;
			await command.handler("refresh", runner.createCommandContext());
			expect(session.model?.contextWindow).toBe(500_000);
			expect(session.configuredThinkingLevel()).toBe("auto");
		} finally {
			await session.dispose();
		}
	} finally {
		server.stop(true);
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
