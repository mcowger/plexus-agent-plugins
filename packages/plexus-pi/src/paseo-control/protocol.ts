import { z } from "zod";

/** Envelope protocol version shared by requests, replies, state, bridge records, and entries. */
export const PROTOCOL_VERSION = 1;

/** Prefix on every `ctx.ui.notify` message that carries a control reply. */
export const NOTIFY_PREFIX = "plexuspi:v1:";
/** Prefix on unsolicited live-state notifications. */
export const STATE_NOTIFY_PREFIX = "plexuspi:state:v1:";
/** Prefix on forwarded owned-subagent bridge records. */
export const CHILD_NOTIFY_PREFIX = "plexuspi:child:v1:";

/** Pi slash command carrying base64url-encoded JSON requests. */
export const COMMAND_NAME = "plexuspi-control";

/** Session custom-entry type for branch-local control settings. */
export const CUSTOM_ENTRY_TYPE = "plexuspi-controls";
/** Session custom-entry type pinning the active branch after a rewind. */
export const REWIND_ENTRY_TYPE = "plexuspi-rewind";

/** Cross-extension bus channel carrying owned-subagent bridge records. */
export const SUBAGENT_BRIDGE_CHANNEL = "plexuspi:subagent:v1";
/** Schema version of every owned-subagent bridge record. */
export const SUBAGENT_BRIDGE_VERSION = 1;

/** Bus channel announcing an activated root session. */
export const ROOT_SIGNAL_CHANNEL = "plexuspi:root:v1";
export const ROOT_SIGNAL_VERSION = 1;

/** Launch environment variable carrying the integration session key. */
export const SESSION_KEY_ENV = "PLEXUSPI_SESSION_KEY";

export const TierSchema = z.string().min(1).max(100);
export type Tier = z.infer<typeof TierSchema>;

/** Tier value reported when no advertised tier is selected. */
export const NO_TIER = "default";

export const SettingsSchema = z.strictObject({
	tier: TierSchema,
	longContext: z.boolean(),
});

export const OperationSchema = z.enum([
	"hello",
	"get-state",
	"configure",
	"rewind",
	"reload",
]);
export type Operation = z.infer<typeof OperationSchema>;

export const ConfigureDataSchema = z.strictObject({
	tier: TierSchema.optional(),
	longContext: z.boolean().optional(),
});
export type ConfigureData = z.infer<typeof ConfigureDataSchema>;

export const RewindDataSchema = z.strictObject({
	targetEntryId: z.string().min(1),
});

/** Rewind reply data. `leafId` is omitted when navigation reset to the root. */
export const RewindResultSchema = z.strictObject({
	cancelled: z.boolean(),
	targetEntryId: z.string().min(1),
	leafId: z.string().optional(),
	settings: SettingsSchema,
	activeChildren: z.number().int().nonnegative(),
});
export type RewindResult = z.infer<typeof RewindResultSchema>;

/** Branch pin appended after a successful rewind. */
export const RewindEntrySchema = z.strictObject({
	version: z.literal(PROTOCOL_VERSION),
	targetEntryId: z.string().min(1),
	leafId: z.string().nullable().optional(),
	timestamp: z.number().int().nonnegative(),
});
export type RewindEntry = z.infer<typeof RewindEntrySchema>;

/**
 * One owned-subagent bridge record (shape owned by the pi-subagents bridge).
 * Unknown top-level keys are rejected so schema drift is visible.
 */
export const SubagentBridgeRecordSchema = z.strictObject({
	version: z.literal(SUBAGENT_BRIDGE_VERSION),
	runId: z.string().min(1),
	sequence: z.number().int().positive(),
	type: z.enum(["created", "activity", "terminal"]),
	parentRunId: z.string().optional(),
	parentSessionId: z.string().optional(),
	childSessionId: z.string().optional(),
	toolCallId: z.string().optional(),
	title: z.string().optional(),
	timestamp: z.number().optional(),
	transcriptPath: z.string().optional(),
	cwd: z.string().optional(),
	record: z.unknown().optional(),
	outcome: z.enum(["completed", "steered", "canceled", "failed"]).optional(),
	result: z.unknown().optional(),
	reason: z.string().optional(),
	omitted: z.boolean().optional(),
	omittedBytes: z.number().int().nonnegative().optional(),
});
export type SubagentBridgeRecord = z.infer<typeof SubagentBridgeRecordSchema>;

/** Forwarded child envelope emitted as `plexuspi:child:v1:<json>`. */
export const ChildForwardSchema = z.strictObject({
	version: z.literal(SUBAGENT_BRIDGE_VERSION),
	sessionKey: z.string(),
	record: SubagentBridgeRecordSchema,
});
export type ChildForward = z.infer<typeof ChildForwardSchema>;

export const PlexuspiRequestSchema = z.object({
	version: z.literal(PROTOCOL_VERSION),
	sessionKey: z.string().min(1),
	requestId: z.string().min(1),
	operation: OperationSchema,
	data: z.unknown().optional(),
});
export type PlexuspiRequest = z.infer<typeof PlexuspiRequestSchema>;

export const ConflictSchema = z.strictObject({
	owner: z.string().min(1),
	command: z.string().min(1),
	resolution: z.string().min(1),
});
export type Conflict = z.infer<typeof ConflictSchema>;

/**
 * Live control state reported by `hello`, `get-state`, `configure`, `rewind`
 * and `plexuspi:state:v1:` notifications. Optional fields are omitted when they
 * cannot be observed, never fabricated.
 */
export const PlexuspiStateSchema = z.strictObject({
	capabilities: z.array(z.string()),
	settings: SettingsSchema,
	contextWindow: z.number().int().nonnegative().optional(),
	activeChildren: z.number().int().nonnegative().optional(),
	sessionId: z.string().optional(),
	origin: z.literal("root"),
	tiers: z.array(TierSchema),
	longContextTarget: z.number().int().nonnegative().optional(),
	longContextAvailable: z.boolean().optional(),
	shortContextBudgetTokens: z.number().int().positive().optional(),
	pricingThresholdInputTokens: z.number().int().positive().optional(),
	contextPolicyError: z.string().optional(),
	modelBaselineContextWindow: z.number().int().nonnegative().optional(),
	tierApplicable: z.boolean(),
	conflicts: z.array(ConflictSchema),
	limitations: z.array(z.string()),
});
export type PlexuspiState = z.infer<typeof PlexuspiStateSchema>;

export const PlexuspiReplySchema = z.strictObject({
	version: z.literal(PROTOCOL_VERSION),
	sessionKey: z.string(),
	requestId: z.string(),
	operation: OperationSchema,
	ok: z.boolean(),
	data: z.unknown().optional(),
	error: z.string().optional(),
});
export type PlexuspiReply = z.infer<typeof PlexuspiReplySchema>;

export const ControlEntrySchema = z.strictObject({
	version: z.literal(PROTOCOL_VERSION),
	tier: TierSchema,
	longContext: z.boolean(),
	contextWindow: z.number().int().nonnegative().optional(),
	timestamp: z.number().int().nonnegative(),
});
export type ControlEntry = z.infer<typeof ControlEntrySchema>;

export function formatIssues(error: z.ZodError): string {
	return error.issues
		.map(
			(issue) =>
				`${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`,
		)
		.join("; ");
}

export function encodeBase64Url(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

export function decodeBase64Url(value: string): string {
	return Buffer.from(value, "base64url").toString("utf8");
}

export function encodeRequest(request: PlexuspiRequest): string {
	return encodeBase64Url(JSON.stringify(request));
}

export type ParsedRequestResult =
	| { ok: true; request: PlexuspiRequest }
	| {
			ok: false;
			error: string;
			sessionKey: string;
			requestId: string;
			operation: Operation;
	  };

/**
 * Parse the slash-command argument into a validated request. Failures keep any
 * correlation fields that are recoverable so the reply can still be matched.
 */
export function parseRequestArg(args: string): ParsedRequestResult {
	const fail = (error: string): ParsedRequestResult => ({
		ok: false,
		error,
		sessionKey: "",
		requestId: "",
		operation: "hello",
	});
	const trimmed = args.trim();
	if (!trimmed) return fail("missing base64url-encoded request");

	let json: string;
	try {
		json = decodeBase64Url(trimmed);
	} catch {
		return fail("invalid base64url request");
	}
	if (json.trim().length === 0) return fail("empty request payload");

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return fail("request payload is not valid JSON");
	}

	const result = PlexuspiRequestSchema.safeParse(parsed);
	if (result.success) return { ok: true, request: result.data };

	const loose = (parsed ?? {}) as Record<string, unknown>;
	const operation = OperationSchema.safeParse(loose.operation);
	return {
		ok: false,
		error: `invalid request: ${formatIssues(result.error)}`,
		sessionKey: typeof loose.sessionKey === "string" ? loose.sessionKey : "",
		requestId: typeof loose.requestId === "string" ? loose.requestId : "",
		operation: operation.success ? operation.data : "hello",
	};
}
