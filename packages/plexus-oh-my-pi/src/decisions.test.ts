import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeJudge } from "@oh-my-pi/pi-ai/judgment";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { convertDescriptors } from "../../plexus-models/src/index.ts";
import { resetConfigCache } from "./config.ts";
import plexusExtension from "./extension.ts";

test("discovers Decisions aliases as judges and sends System One requests through Plexus", async () => {
	const dir = mkdtempSync(join(tmpdir(), "plexus-judge-"));
	const previousDir = getAgentDir();
	const oldUrl = Bun.env.PLEXUS_API_URL;
	const oldKey = Bun.env.PLEXUS_API_KEY;
	const oldSuppress = Bun.env.PLEXUS_SUPPRESS_MODELS;
	const data = [
		{ id: "chat-model", type: "text" },
		{ id: "judge-alias", type: "decisions" },
		{ id: "hidden-judge", type: "decisions" },
	];
	const received: { authorization?: string | null; request?: unknown } = {};
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === "/v1/models") return Response.json({ data });
			if (path === "/v1/systemone") {
				received.authorization = req.headers.get("authorization");
				received.request = await req.json();
				return Response.json({
					answers: { relevant: { type: "noul", noul: 0.9 } },
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
	Bun.env.PLEXUS_API_URL = `http://127.0.0.1:${server.port}/v1`;
	Bun.env.PLEXUS_API_KEY = "fixture-key";
	Bun.env.PLEXUS_SUPPRESS_MODELS = "hidden-judge";
	setAgentDir(dir);
	resetConfigCache();
	const auth = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(auth, join(dir, "models.json"));
	try {
		plexusExtension({
			on() {},
			registerCommand() {},
			registerProvider(
				name: string,
				config: Parameters<ExtensionAPI["registerProvider"]>[1],
			) {
				registry.registerProvider(name, config, "ext://plexus-judge-test");
			},
		} as unknown as ExtensionAPI);
		await registry.refreshRuntimeProviders("online");
		expect(
			convertDescriptors(data, Bun.env.PLEXUS_API_URL).map((m) => m.id),
		).toEqual(["chat-model"]);
		const model = registry.find("plexus", "judge-alias");
		expect(model).toMatchObject({
			kind: "judge",
			api: "typesafe",
			baseUrl: `http://127.0.0.1:${server.port}`,
		});
		expect(registry.find("plexus", "hidden-judge")).toBeUndefined();
		expect(registry.find("plexus", "chat-model")?.baseUrl).toBe(
			`http://127.0.0.1:${server.port}/v1`,
		);
		if (!model) throw new Error("judge not found");
		const key = await auth.getApiKey("plexus");
		if (!key) throw new Error("credential not found");
		const questions = {
			relevant: { type: "noul" as const, instructions: "Is this relevant?" },
		};
		const result = await createNativeJudge(model, { apiKey: key }).judge({
			state: "A relevant example",
			questions,
		});
		expect(result.answers.relevant.noul).toBe(0.9);
		expect(received.authorization).toBe("Bearer fixture-key");
		expect(received.request).toEqual({
			model: "judge-alias",
			state: "A relevant example",
			questions,
		});
	} finally {
		server.stop(true);
		registry.clearSourceRegistrations("ext://plexus-judge-test");
		auth.close();
		setAgentDir(previousDir);
		resetConfigCache();
		if (oldUrl === undefined) delete Bun.env.PLEXUS_API_URL;
		else Bun.env.PLEXUS_API_URL = oldUrl;
		if (oldKey === undefined) delete Bun.env.PLEXUS_API_KEY;
		else Bun.env.PLEXUS_API_KEY = oldKey;
		if (oldSuppress === undefined) delete Bun.env.PLEXUS_SUPPRESS_MODELS;
		else Bun.env.PLEXUS_SUPPRESS_MODELS = oldSuppress;
		rmSync(dir, { recursive: true, force: true });
	}
});
