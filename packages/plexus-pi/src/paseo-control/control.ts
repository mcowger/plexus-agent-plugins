import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type {
	PolicyController,
	PolicyHost,
	PolicyModel,
	PolicyResolver,
} from "../policy.ts";
import { createSubagentBridgeTracker, formatChildForward } from "./bridge.ts";
import { detectControlConflicts } from "./conflicts.ts";
import {
	COMMAND_NAME,
	ConfigureDataSchema,
	type Conflict,
	type ControlEntry,
	ControlEntrySchema,
	CUSTOM_ENTRY_TYPE,
	formatIssues,
	NO_TIER,
	NOTIFY_PREFIX,
	type PlexuspiReply,
	PlexuspiReplySchema,
	type PlexuspiRequest,
	type PlexuspiState,
	PlexuspiStateSchema,
	PROTOCOL_VERSION,
	parseRequestArg,
	REWIND_ENTRY_TYPE,
	RewindDataSchema,
	type RewindResult,
	ROOT_SIGNAL_CHANNEL,
	ROOT_SIGNAL_VERSION,
	SESSION_KEY_ENV,
	STATE_NOTIFY_PREFIX,
	SUBAGENT_BRIDGE_CHANNEL,
	SubagentBridgeRecordSchema,
} from "./protocol.ts";
import {
	buildRewindEntry,
	findActiveBranchUserEntry,
	navigationCancelled,
} from "./rewind.ts";
import { isTierApplicable, resolveSavedTier } from "./tier.ts";

/** Operations implemented by the Plexus control module. */
export const CAPABILITIES: readonly string[] = [
	"hello",
	"get-state",
	"configure",
	"rewind",
	"reload",
];

const LIMITATIONS: readonly string[] = [
	"rewind restores Pi's active branch and appends a branch pin; it never writes files and never summarizes the abandoned future",
	"rewind is rejected while the root agent is busy, while a compaction is in progress, or while owned children are active",
	"the provider must clear its own queued input before asking the module to navigate",
	"reload is accepted while idle and the ok reply is emitted before reloading, so ok means started rather than finished; the provider confirms completion by re-reading state and commands",
	"reload re-reads settings, extensions, skills, prompts, themes, and context files without touching the session history; files that arrive after reload starts are not picked up",
	"host history replacement after rewind is the provider's supported-adapter concern, not a module-invented reset event",
	"active owned children are counted from the pi-subagents bridge; children not bridged are not visible",
	"advertised service tiers describe Plexus capabilities, not a routing or backend acceptance guarantee",
	"context budgets come from Plexus policy metadata; models without distinct short/max budgets have no long-context control",
];

const APPLY_ERROR = "Pi could not apply the context policy budget.";

export interface PaseoControlDeps {
	/** The session's policy engine; this module installs its resolver on activation. */
	policy: PolicyController;
	/** The same host the policy engine uses; supplies catalog metadata. */
	host: PolicyHost;
}

export interface PaseoControlOptions {
	/** Expected integration session key. Defaults to `PLEXUSPI_SESSION_KEY`. */
	sessionKey?: string;
	/** Clock for persisted entry timestamps. */
	now?: () => number;
}

export interface PaseoControlHandle {
	/** True once an authenticated root request has activated this session. */
	readonly active: boolean;
	handleArgs(args: string, ctx: ExtensionCommandContext): Promise<void>;
	buildState(ctx: ExtensionContext): PlexuspiState;
	/** Owned runs that have not reached a terminal bridge record. */
	activeChildren(): number;
}

function normalizeKey(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function readSessionId(ctx: ExtensionContext): string | undefined {
	try {
		const id = ctx.sessionManager.getSessionId();
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

function readLeafId(ctx: ExtensionContext): string | undefined {
	try {
		const id = ctx.sessionManager.getLeafId();
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

function readBranch(
	ctx: ExtensionContext,
): ReturnType<ExtensionContext["sessionManager"]["getBranch"]> {
	try {
		return ctx.sessionManager.getBranch();
	} catch {
		return [];
	}
}

/**
 * Plexus control protocol for the Plexus root session.
 *
 * Lazy activation only: the module activates on the first control request whose
 * session key matches `PLEXUSPI_SESSION_KEY`. Control requests reach the root
 * session only through its RPC prompt dispatch; child SDK sessions inherit the
 * environment but never receive such requests, so they never activate. Until
 * activation the module registers the command and touches nothing else.
 */
export function createPlexuspiControl(
	pi: ExtensionAPI,
	deps: PaseoControlDeps,
	options: PaseoControlOptions = {},
): PaseoControlHandle {
	const { policy, host } = deps;
	const now = options.now ?? (() => Date.now());
	const expectedSessionKey = normalizeKey(
		options.sessionKey ?? process.env[SESSION_KEY_ENV],
	);

	const bridgeTracker = createSubagentBridgeTracker(expectedSessionKey ?? "");
	let active = false;
	let closed = false;
	let latestCtx: ExtensionContext | undefined;
	let compactionActive = false;
	let desiredTier = NO_TIER;
	let desiredLongContext = false;
	let resolvedTier = NO_TIER;
	let suspendPersist = false;
	let persistedKey = "";
	let unsubscribeBridge: (() => void) | undefined;
	let unsubscribeView: (() => void) | undefined;

	/**
	 * Saved intent survives metadata loading and model switches. The budget
	 * intent is dropped only when the catalog is ready and has no qualifying
	 * policy for this model; a saved tier stays until it can be honoured.
	 */
	const resolveIntent: PolicyResolver = (_model, advertisement) => {
		const choices = advertisement?.serviceTier?.serviceTiers ?? [];
		resolvedTier = resolveSavedTier(desiredTier, choices);
		if (
			choices.includes(desiredTier) ||
			(desiredTier === "fast" && resolvedTier === "priority") ||
			(desiredTier === NO_TIER &&
				(resolvedTier === "auto" || resolvedTier === "standard"))
		) {
			desiredTier = resolvedTier;
		}
		const context = advertisement?.context;
		const distinct =
			context !== undefined &&
			context.shortContextBudgetTokens < context.maxContextTokens;
		if (!distinct && host.hasCatalogContextPolicy()) desiredLongContext = false;
		return { longContext: desiredLongContext, serviceTier: resolvedTier };
	};

	function reportedSettings(): { tier: string; longContext: boolean } {
		return {
			tier: resolvedTier,
			longContext: policy.getView().selection.longContext,
		};
	}

	function plexusModel(
		model: { provider?: string; id?: string } | undefined,
	): PolicyModel | undefined {
		return model?.provider === "plexus" && typeof model.id === "string"
			? { provider: "plexus", id: model.id }
			: undefined;
	}

	function advertisementFor(
		model: { provider?: string; id?: string } | undefined,
	) {
		const identity = plexusModel(model);
		return identity ? host.getAdvertisement(identity) : undefined;
	}

	function conflicts(): Conflict[] {
		try {
			return detectControlConflicts(pi.getCommands());
		} catch {
			return [];
		}
	}

	function buildState(ctx: ExtensionContext): PlexuspiState {
		const model = ctx.model;
		const identity = plexusModel(model);
		const advertisement = advertisementFor(model);
		const context = advertisement?.context;
		const settings = reportedSettings();
		const state: PlexuspiState = {
			capabilities: [...CAPABILITIES],
			settings,
			origin: "root",
			tiers: [...(advertisement?.serviceTier?.serviceTiers ?? [])],
			longContextAvailable:
				context !== undefined &&
				context.shortContextBudgetTokens < context.maxContextTokens,
			tierApplicable: isTierApplicable(
				model,
				settings.tier,
				advertisement?.serviceTier,
			),
			conflicts: conflicts(),
			limitations: [...LIMITATIONS],
			activeChildren: bridgeTracker.activeChildren(),
		};
		if (typeof model?.contextWindow === "number")
			state.contextWindow = model.contextWindow;
		const sessionId = readSessionId(ctx);
		if (sessionId !== undefined) state.sessionId = sessionId;
		if (context) {
			state.longContextTarget = context.maxContextTokens;
			state.shortContextBudgetTokens = context.shortContextBudgetTokens;
			if (context.pricingThresholdInputTokens !== undefined)
				state.pricingThresholdInputTokens = context.pricingThresholdInputTokens;
		}
		const baseline = identity
			? host.getCatalogContextWindow(identity)
			: undefined;
		if (baseline !== undefined) state.modelBaselineContextWindow = baseline;
		if (policy.getView().applyFailed) state.contextPolicyError = APPLY_ERROR;
		return PlexuspiStateSchema.parse(state);
	}

	function publishState(ctx: ExtensionContext): void {
		if (!expectedSessionKey) return;
		ctx.ui.notify(
			`${STATE_NOTIFY_PREFIX}${JSON.stringify({ version: PROTOCOL_VERSION, sessionKey: expectedSessionKey, state: buildState(ctx) })}`,
			"info",
		);
	}

	function emit(ctx: ExtensionCommandContext, reply: PlexuspiReply): void {
		const validated = PlexuspiReplySchema.parse(reply);
		ctx.ui.notify(
			`${NOTIFY_PREFIX}${JSON.stringify(validated)}`,
			validated.ok ? "info" : "warning",
		);
	}

	function base(request: PlexuspiRequest) {
		return {
			version: PROTOCOL_VERSION,
			sessionKey: request.sessionKey,
			requestId: request.requestId,
			operation: request.operation,
		} as const;
	}

	function controlKey(): string {
		return JSON.stringify({
			tier: desiredTier,
			longContext: reportedSettings().longContext,
		});
	}

	/** Persist branch-local intent when it changed, unless a restore is settling. */
	function persistIfChanged(): void {
		if (suspendPersist) return;
		const key = controlKey();
		if (key === persistedKey) return;
		persistedKey = key;
		const model = policy.getView().model;
		const baseline = model ? host.getCatalogContextWindow(model) : undefined;
		pi.appendEntry(CUSTOM_ENTRY_TYPE, {
			version: PROTOCOL_VERSION,
			tier: desiredTier,
			longContext: reportedSettings().longContext,
			...(baseline !== undefined ? { contextWindow: baseline } : {}),
			timestamp: now(),
		});
	}

	function onPolicyCommit(): void {
		if (!active || closed) return;
		persistIfChanged();
		if (latestCtx) publishState(latestCtx);
	}

	function latestControlEntry(ctx: ExtensionContext): ControlEntry | undefined {
		let latest: ControlEntry | undefined;
		for (const entry of readBranch(ctx)) {
			if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE)
				continue;
			const parsed = ControlEntrySchema.safeParse(entry.data);
			if (parsed.success) latest = parsed.data;
		}
		return latest;
	}

	/** Re-read the branch-local intent and apply it to the session model. */
	async function restore(ctx: ExtensionContext): Promise<void> {
		const entry = latestControlEntry(ctx);
		desiredTier = entry?.tier ?? NO_TIER;
		desiredLongContext = entry?.longContext ?? false;
		suspendPersist = true;
		try {
			await policy.reconcile();
		} finally {
			suspendPersist = false;
		}
		persistedKey = controlKey();
	}

	function forwardBridgeRecord(data: unknown): void {
		if (!active || closed) return;
		const parsed = SubagentBridgeRecordSchema.safeParse(data);
		if (!parsed.success) return;
		const forward = bridgeTracker.accept(parsed.data);
		// Native message/tool activity comes from the bridge record; the child
		// transcript path is never read.
		if (!forward || !latestCtx) return;
		latestCtx.ui.notify(formatChildForward(forward), "info");
	}

	function emitRootSignal(ctx: ExtensionContext): void {
		const sessionId = readSessionId(ctx);
		if (sessionId === undefined) return;
		pi.events.emit(ROOT_SIGNAL_CHANNEL, {
			version: ROOT_SIGNAL_VERSION,
			sessionId,
		});
	}

	/** Lazy activation: runs once, on the first authenticated root request. */
	async function activate(ctx: ExtensionCommandContext): Promise<void> {
		latestCtx = ctx;
		if (active) return;
		active = true;
		policy.setResolver(resolveIntent);
		unsubscribeView = policy.subscribe(onPolicyCommit);
		unsubscribeBridge = pi.events.on(
			SUBAGENT_BRIDGE_CHANNEL,
			forwardBridgeRecord,
		);
		await restore(ctx);
		emitRootSignal(ctx);
	}

	function rewindResult(
		cancelled: boolean,
		targetEntryId: string,
		ctx: ExtensionContext,
	): RewindResult {
		const leafId = readLeafId(ctx);
		return {
			cancelled,
			targetEntryId,
			...(leafId !== undefined ? { leafId } : {}),
			settings: reportedSettings(),
			activeChildren: bridgeTracker.activeChildren(),
		};
	}

	function handleHello(
		request: PlexuspiRequest,
		ctx: ExtensionCommandContext,
	): void {
		const data = buildState(ctx);
		if (data.conflicts.length > 0) {
			const detail = data.conflicts
				.map((conflict) => `${conflict.owner} owns ${conflict.command}`)
				.join("; ");
			const resolutions = data.conflicts
				.map((conflict) => conflict.resolution)
				.join(" ");
			emit(ctx, {
				...base(request),
				ok: false,
				data,
				error: `known control owner conflict: ${detail}. ${resolutions}`,
			});
			return;
		}
		emit(ctx, { ...base(request), ok: true, data });
	}

	async function handleConfigure(
		request: PlexuspiRequest,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const parsed = ConfigureDataSchema.safeParse(request.data ?? {});
		if (!parsed.success) {
			emit(ctx, {
				...base(request),
				ok: false,
				error: `invalid configure data: ${formatIssues(parsed.error)}`,
			});
			return;
		}

		const advertisement = advertisementFor(ctx.model);
		const choices = advertisement?.serviceTier?.serviceTiers ?? [];
		const requestedTier = parsed.data.tier;
		const nextTier =
			requestedTier === undefined
				? resolvedTier
				: choices.includes(requestedTier)
					? requestedTier
					: requestedTier === "fast"
						? "priority"
						: requestedTier === NO_TIER
							? resolveSavedTier(requestedTier, choices)
							: requestedTier;
		if (requestedTier !== undefined && !choices.includes(nextTier)) {
			emit(ctx, {
				...base(request),
				ok: false,
				data: buildState(ctx),
				error: `Service tier '${requestedTier}' is not advertised for the current model.`,
			});
			return;
		}

		const nextLongContext =
			parsed.data.longContext ?? reportedSettings().longContext;
		const context = advertisement?.context;
		if (
			nextLongContext &&
			(!context || context.shortContextBudgetTokens >= context.maxContextTokens)
		) {
			emit(ctx, {
				...base(request),
				ok: false,
				data: buildState(ctx),
				error:
					"The current model has no distinct short and long context budgets.",
			});
			return;
		}

		// Budget first: a failed application leaves the previous tier and intent untouched.
		if (parsed.data.longContext !== undefined) {
			const previousLongContext = desiredLongContext;
			desiredLongContext = nextLongContext;
			await policy.reconcile();
			if (policy.getView().applyFailed) {
				desiredLongContext = previousLongContext;
				emit(ctx, {
					...base(request),
					ok: false,
					data: buildState(ctx),
					error: APPLY_ERROR,
				});
				return;
			}
		}

		if (requestedTier !== undefined) {
			desiredTier = nextTier;
			await policy.reconcile();
		}
		emit(ctx, { ...base(request), ok: true, data: buildState(ctx) });
	}

	async function handleRewind(
		request: PlexuspiRequest,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const parsed = RewindDataSchema.safeParse(request.data ?? {});
		if (!parsed.success) {
			emit(ctx, {
				...base(request),
				ok: false,
				error: `invalid rewind data: ${formatIssues(parsed.error)}`,
			});
			return;
		}
		const { targetEntryId } = parsed.data;

		if (!ctx.isIdle()) {
			emit(ctx, {
				...base(request),
				ok: false,
				data: buildState(ctx),
				error: "rewind requires an idle agent",
			});
			return;
		}
		if (compactionActive) {
			emit(ctx, {
				...base(request),
				ok: false,
				data: buildState(ctx),
				error: "rewind is unavailable while a compaction is in progress",
			});
			return;
		}
		const activeChildren = bridgeTracker.activeChildren();
		if (activeChildren > 0) {
			emit(ctx, {
				...base(request),
				ok: false,
				data: buildState(ctx),
				error: `rewind is unavailable while ${activeChildren} owned child session(s) are active`,
			});
			return;
		}

		const target = findActiveBranchUserEntry(readBranch(ctx), targetEntryId);
		if (!target.ok) {
			emit(ctx, {
				...base(request),
				ok: false,
				data: buildState(ctx),
				error: `invalid rewind target: ${target.error}`,
			});
			return;
		}

		let result: unknown;
		try {
			result = await ctx.navigateTree(targetEntryId, { summarize: false });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			emit(ctx, {
				...base(request),
				ok: false,
				data: buildState(ctx),
				error: `rewind navigation failed: ${message}`,
			});
			return;
		}

		if (navigationCancelled(result)) {
			emit(ctx, {
				...base(request),
				ok: false,
				data: rewindResult(true, targetEntryId, ctx),
				error: "rewind was cancelled before navigation completed.",
			});
			return;
		}

		const leafId = readLeafId(ctx) ?? null;
		pi.appendEntry(
			REWIND_ENTRY_TYPE,
			buildRewindEntry(targetEntryId, leafId, now()),
		);
		latestCtx = ctx;
		await restore(ctx);
		emit(ctx, {
			...base(request),
			ok: true,
			data: rewindResult(false, targetEntryId, ctx),
		});
	}

	async function handleReload(
		request: PlexuspiRequest,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		if (!ctx.isIdle()) {
			emit(ctx, {
				...base(request),
				ok: false,
				data: buildState(ctx),
				error: "reload is unavailable while the agent is busy",
			});
			return;
		}
		if (compactionActive) {
			emit(ctx, {
				...base(request),
				ok: false,
				data: buildState(ctx),
				error: "reload is unavailable while a compaction is in progress",
			});
			return;
		}
		const activeChildren = bridgeTracker.activeChildren();
		if (activeChildren > 0) {
			emit(ctx, {
				...base(request),
				ok: false,
				data: buildState(ctx),
				error: `reload is unavailable while ${activeChildren} owned child session(s) are active`,
			});
			return;
		}
		// `ctx.reload()` invalidates this extension instance, so the ok reply is
		// emitted first. The provider confirms completion by re-reading state.
		emit(ctx, { ...base(request), ok: true, data: buildState(ctx) });
		await ctx.reload();
	}

	async function handleArgs(
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> {
		const parsed = parseRequestArg(args);
		if (!parsed.ok) {
			emit(ctx, {
				version: PROTOCOL_VERSION,
				sessionKey: parsed.sessionKey,
				requestId: parsed.requestId,
				operation: parsed.operation,
				ok: false,
				error: parsed.error,
			});
			return;
		}

		const request = parsed.request;
		const refuse = (error: string) =>
			emit(ctx, { ...base(request), ok: false, error });
		if (!expectedSessionKey) {
			refuse(
				`${SESSION_KEY_ENV} is not set for this process; refusing control request.`,
			);
			return;
		}
		if (request.sessionKey !== expectedSessionKey) {
			refuse("session key mismatch; refusing control request.");
			return;
		}

		await activate(ctx);

		switch (request.operation) {
			case "hello":
				handleHello(request, ctx);
				return;
			case "get-state":
				emit(ctx, { ...base(request), ok: true, data: buildState(ctx) });
				return;
			case "configure":
				await handleConfigure(request, ctx);
				return;
			case "rewind":
				await handleRewind(request, ctx);
				return;
			case "reload":
				await handleReload(request, ctx);
				return;
		}
	}

	pi.registerCommand(COMMAND_NAME, {
		description: "Plexus control protocol (base64url-encoded JSON).",
		handler: (args, ctx) => handleArgs(args, ctx),
	});

	pi.on("session_start", (_event, ctx) => {
		if (!active || closed) return undefined;
		latestCtx = ctx;
		return restore(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		if (!active || closed) return undefined;
		latestCtx = ctx;
		return restore(ctx);
	});
	pi.on("model_select", (_event, ctx) => {
		if (!active || closed) return;
		latestCtx = ctx;
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!active || closed) return;
		latestCtx = ctx;
		await policy.reconcile();
		if (policy.getView().applyFailed) throw new Error(APPLY_ERROR);
	});
	pi.on("session_before_compact", () => {
		compactionActive = true;
	});
	pi.on("session_compact", () => {
		compactionActive = false;
	});
	pi.on("session_compact_failed", () => {
		compactionActive = false;
	});
	pi.on("session_shutdown", () => {
		closed = true;
		compactionActive = false;
		unsubscribeBridge?.();
		unsubscribeBridge = undefined;
		unsubscribeView?.();
		unsubscribeView = undefined;
		if (active) policy.setResolver(undefined);
		latestCtx = undefined;
	});

	return {
		get active() {
			return active;
		},
		handleArgs,
		buildState,
		activeChildren: () => bridgeTracker.activeChildren(),
	};
}
