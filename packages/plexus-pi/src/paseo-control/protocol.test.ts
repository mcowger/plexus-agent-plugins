import { describe, expect, test } from "bun:test";
import {
	ConfigureDataSchema,
	ControlEntrySchema,
	decodeBase64Url,
	encodeBase64Url,
	encodeRequest,
	formatIssues,
	PlexuspiReplySchema,
	type PlexuspiRequest,
	PlexuspiStateSchema,
	parseRequestArg,
	RewindDataSchema,
	SubagentBridgeRecordSchema,
} from "./protocol.ts";

const validState = {
	capabilities: ["hello"],
	settings: { tier: "default", longContext: false },
	origin: "root",
	tiers: [],
	tierApplicable: false,
	conflicts: [],
	limitations: [],
};

describe("request parsing", () => {
	test("parses an encoded request and keeps its fields", () => {
		const request: PlexuspiRequest = {
			version: 1,
			sessionKey: "k",
			requestId: "r1",
			operation: "get-state",
		};
		const parsed = parseRequestArg(encodeRequest(request));
		expect(parsed).toEqual({ ok: true, request });
	});

	test("trims surrounding whitespace around the argument", () => {
		const arg = `  ${encodeRequest({ version: 1, sessionKey: "k", requestId: "r", operation: "hello" } as never)}\n`;
		expect(parseRequestArg(arg).ok).toBe(true);
	});

	test("keeps data on configure and rewind requests", () => {
		const parsed = parseRequestArg(
			encodeRequest({
				version: 1,
				sessionKey: "k",
				requestId: "r",
				operation: "configure",
				data: { tier: "flex" },
			} as never),
		);
		expect(parsed).toMatchObject({
			ok: true,
			request: { data: { tier: "flex" } },
		});
	});

	test("rejects empty, non-base64, and non-JSON payloads without correlation fields", () => {
		expect(parseRequestArg("   ")).toMatchObject({
			ok: false,
			error: "missing base64url-encoded request",
			requestId: "",
		});
		expect(parseRequestArg("!!!")).toMatchObject({
			ok: false,
			error: "empty request payload",
		});
		expect(parseRequestArg(encodeBase64Url("not json"))).toMatchObject({
			ok: false,
			error: "request payload is not valid JSON",
		});
	});

	test("recovers correlation fields and falls back to hello for unknown operations", () => {
		const parsed = parseRequestArg(
			encodeRequest({
				version: 1,
				sessionKey: "k",
				requestId: "c1",
				operation: "compact",
			} as never),
		);
		expect(parsed).toMatchObject({
			ok: false,
			sessionKey: "k",
			requestId: "c1",
			operation: "hello",
		});
		if (parsed.ok) throw new Error("expected failure");
		expect(parsed.error).toMatch(/^invalid request: /);
	});

	test("rejects an unsupported protocol version", () => {
		const parsed = parseRequestArg(
			encodeRequest({
				version: 2,
				sessionKey: "k",
				requestId: "r",
				operation: "hello",
			} as never),
		);
		expect(parsed).toMatchObject({
			ok: false,
			operation: "hello",
			requestId: "r",
		});
	});

	test("rejects a request missing its requestId and recovers the operation", () => {
		const parsed = parseRequestArg(
			encodeRequest({
				version: 1,
				sessionKey: "k",
				operation: "reload",
			} as never),
		);
		expect(parsed).toMatchObject({
			ok: false,
			sessionKey: "k",
			requestId: "",
			operation: "reload",
		});
	});
});

describe("base64url", () => {
	test("round-trips UTF-8 and emits URL-safe characters only", () => {
		const text = JSON.stringify({ tier: "??>>~~ünïcode" });
		const encoded = encodeBase64Url(text);
		expect(encoded).not.toMatch(/[+/=]/);
		expect(decodeBase64Url(encoded)).toBe(text);
	});
});

describe("request data schemas", () => {
	test("configure accepts known fields and rejects unknown or empty values", () => {
		expect(
			ConfigureDataSchema.safeParse({ tier: "flex", longContext: true })
				.success,
		).toBe(true);
		expect(ConfigureDataSchema.safeParse({}).success).toBe(true);
		expect(ConfigureDataSchema.safeParse({ turbo: true }).success).toBe(false);
		expect(ConfigureDataSchema.safeParse({ tier: "" }).success).toBe(false);
		expect(ConfigureDataSchema.safeParse({ longContext: "yes" }).success).toBe(
			false,
		);
	});

	test("configure errors name the offending field", () => {
		const result = ConfigureDataSchema.safeParse({ longContext: "yes" });
		if (result.success) throw new Error("expected failure");
		expect(formatIssues(result.error)).toContain("longContext");
	});

	test("rewind requires a non-empty target and no extra fields", () => {
		expect(RewindDataSchema.safeParse({ targetEntryId: "u1" }).success).toBe(
			true,
		);
		expect(RewindDataSchema.safeParse({ targetEntryId: "" }).success).toBe(
			false,
		);
		expect(
			RewindDataSchema.safeParse({ targetEntryId: "u1", extra: 1 }).success,
		).toBe(false);
	});
});

describe("reply, state, and entry schemas", () => {
	test("replies are strict and carry an ok flag", () => {
		const reply = {
			version: 1,
			sessionKey: "k",
			requestId: "r",
			operation: "hello",
			ok: true,
		};
		expect(PlexuspiReplySchema.safeParse(reply).success).toBe(true);
		expect(
			PlexuspiReplySchema.safeParse({ ...reply, extra: true }).success,
		).toBe(false);
		expect(
			PlexuspiReplySchema.safeParse({ ...reply, operation: "compact" }).success,
		).toBe(false);
	});

	test("state requires the root origin and non-negative counts", () => {
		expect(PlexuspiStateSchema.safeParse(validState).success).toBe(true);
		expect(
			PlexuspiStateSchema.safeParse({ ...validState, origin: "child" }).success,
		).toBe(false);
		expect(
			PlexuspiStateSchema.safeParse({ ...validState, activeChildren: -1 })
				.success,
		).toBe(false);
		expect(
			PlexuspiStateSchema.safeParse({ ...validState, settings: { tier: "x" } })
				.success,
		).toBe(false);
	});

	test("control entries are strict and keep optional context window", () => {
		const entry = { version: 1, tier: "flex", longContext: true, timestamp: 1 };
		expect(ControlEntrySchema.safeParse(entry).success).toBe(true);
		expect(
			ControlEntrySchema.safeParse({ ...entry, contextWindow: 1000 }).success,
		).toBe(true);
		expect(
			ControlEntrySchema.safeParse({ ...entry, surprise: 1 }).success,
		).toBe(false);
		expect(ControlEntrySchema.safeParse({ ...entry, version: 2 }).success).toBe(
			false,
		);
	});

	test("bridge records reject schema drift, bad sequences, and unknown outcomes", () => {
		const record = { version: 1, runId: "run", sequence: 1, type: "created" };
		expect(SubagentBridgeRecordSchema.safeParse(record).success).toBe(true);
		expect(
			SubagentBridgeRecordSchema.safeParse({ ...record, surprise: true })
				.success,
		).toBe(false);
		expect(
			SubagentBridgeRecordSchema.safeParse({ ...record, sequence: 0 }).success,
		).toBe(false);
		expect(
			SubagentBridgeRecordSchema.safeParse({ ...record, version: 2 }).success,
		).toBe(false);
		expect(
			SubagentBridgeRecordSchema.safeParse({
				...record,
				type: "terminal",
				outcome: "exploded",
			}).success,
		).toBe(false);
	});
});
