import type { PlexusApiModel } from "../../plexus-models/src/index.ts";
import type { PlexusModelInfo } from "./mapper.ts";

/**
 * Session-scoped Plexus service-tier + context-budget selection for the
 * opencode V2 adapter.
 *
 * This module is host-agnostic: it owns the advertisement derivation
 * (ported from `plexus-pi`'s `contextPolicyFromApiModel` /
 * `serviceTierPolicyFromApiModel` — rules, not code), the per-session
 * selection store, validation, and refresh reconciliation. `plugin.ts`
 * supplies the catalog and wires the session hooks and slash commands.
 *
 * Semantics (ported from `packages/plexus-pi/{service-tiers,context-policy,
 * policy-control}.md`):
 *
 * - Tier names are advertised verbatim as the Plexus server publishes them.
 *   Unknown tiers are rejected atomically — no partial application.
 * - The short budget is the first `pricing.tiers[].input_tokens_above`
 *   value; the maximum is the raw `context_length`. A model advertises a
 *   context budget only when both are positive safe integers and
 *   short <= max. The short/max *choice* additionally requires short < max.
 * - Nothing is ever fabricated: no tiers, no policy; no tiers/pricing, no
 *   context budget.
 * - Selection is keyed by session and bound to the session's model. It
 *   resets when the session's model changes and never mutates the shared
 *   `Model.Info` definitions.
 * - Refresh reconciliation: a removed tier clears the selection; an
 *   equalized (or removed) short budget resets to max; a lowered short
 *   budget is re-applied (the effective window is recomputed live).
 *
 * Wire application (opencode V2 session hook path):
 *
 * - Tier: the `http.request` session hook rewrites the outgoing JSON body to
 *   set `service_tier` — the body field the Plexus gateway honors (same
 *   mechanism as pi's `injectServiceTier`). This one path covers all four
 *   API dialects (chat-completions, anthropic-messages, google, responses).
 * - Context: opencode offers no per-session context-window override, so the
 *   session's effective budget rides the request in
 *   `SessionRequestOptions["plexusContextBudget"]` (see
 *   {@link CONTEXT_BUDGET_OPTION}), set by the `context`/`compaction`
 *   session hooks. It is a provider option: every protocol lowering ignores
 *   unknown provider options, so it never reaches the wire and never alters
 *   generation. `status` reporting and reconciliation treat it as the
 *   authoritative per-session window without touching the shared
 *   `limit.context`.
 */

/** Session-hook options key carrying the session's effective context budget. */
export const CONTEXT_BUDGET_OPTION = "plexusContextBudget";

/**
 * Per-model policy advertisement retained on `PlexusModelInfo.policy`.
 * Shared catalog data (per model, not per session) — safe to keep on the
 * shared definition. Present only when the model advertises at least a
 * service tier or a valid short/max context pair.
 */
export interface PlexusModelPolicy {
	/** Verbatim copy of the raw model's `service_tiers` ([] when none). */
	serviceTiers: string[];
	/** First `pricing.tiers[].input_tokens_above`; present only with `maxContextTokens`. */
	shortContextBudgetTokens?: number;
	/** Raw `context_length`; present only with `shortContextBudgetTokens`. */
	maxContextTokens?: number;
}

/** Per-session selection. Defaults: max budget + provider-default tier. */
export interface PolicySelection {
	/** `true` = advertised maximum, `false` = advertised short budget. */
	longContext: boolean;
	/** Active advertised tier, or `null` for the provider default. */
	serviceTier: string | null;
}

export interface PolicyAvailability {
	longContext: boolean;
	serviceTier: boolean;
}

/** Minimal model identity; matches `Model.Ref` structurally. */
export interface PolicyModelRef {
	providerID: string;
	id: string;
}

const DEFAULT_SELECTION: PolicySelection = Object.freeze({
	longContext: true,
	serviceTier: null,
}) as PolicySelection;

function defaultSelection(): PolicySelection {
	return { ...DEFAULT_SELECTION };
}

function isPositiveSafeInt(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validServiceTiers(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > 64)
		return undefined;
	const tiers: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string" || entry.length === 0 || entry.length > 100)
			return undefined;
		tiers.push(entry);
	}
	// Duplicate, malformed, or missing tier lists are not advertised.
	if (new Set(tiers).size !== tiers.length) return undefined;
	return tiers;
}

/**
 * Derive the policy advertisement for one raw Plexus API model.
 * Returns `undefined` when the model advertises neither service tiers nor a
 * valid short/max context pair.
 */
export function policyAdvertisementFromApiModel(
	model: PlexusApiModel,
): PlexusModelPolicy | undefined {
	const serviceTiers = validServiceTiers(
		(model as PlexusApiModel & { service_tiers?: unknown }).service_tiers,
	);

	const maxContextTokens = model.context_length;
	const shortBudget = model.pricing?.tiers?.[0]?.input_tokens_above;
	const contextValid =
		isPositiveSafeInt(maxContextTokens) &&
		isPositiveSafeInt(shortBudget) &&
		(shortBudget as number) <= (maxContextTokens as number);

	if (serviceTiers === undefined && !contextValid) return undefined;
	return {
		serviceTiers: serviceTiers ?? [],
		...(contextValid
			? {
					shortContextBudgetTokens: shortBudget as number,
					maxContextTokens: maxContextTokens as number,
				}
			: {}),
	};
}

/** Whether the advertisement exposes a distinct short/max choice and any tiers. */
export function policyAvailability(
	policy: PlexusModelPolicy | undefined,
): PolicyAvailability {
	return {
		longContext:
			policy !== undefined &&
			policy.shortContextBudgetTokens !== undefined &&
			policy.maxContextTokens !== undefined &&
			policy.shortContextBudgetTokens < policy.maxContextTokens,
		serviceTier: (policy?.serviceTiers.length ?? 0) > 0,
	};
}

/** The context window the selection resolves to, or `undefined` without a context policy. */
export function effectiveContextWindow(
	policy: PlexusModelPolicy | undefined,
	selection: PolicySelection,
): number | undefined {
	if (
		policy?.shortContextBudgetTokens === undefined ||
		policy.maxContextTokens === undefined
	)
		return undefined;
	if (
		!selection.longContext &&
		policy.shortContextBudgetTokens < policy.maxContextTokens
	) {
		return policy.shortContextBudgetTokens;
	}
	return policy.maxContextTokens;
}

/**
 * Inject `service_tier` into a request payload object, leaving non-object
 * payloads untouched. `null`/`undefined` clears to a passthrough (no tier).
 */
export function injectServiceTier(
	payload: unknown,
	tier: string | null | undefined,
): unknown {
	if (tier === null || tier === undefined) return payload;
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		return payload;
	return { ...(payload as Record<string, unknown>), service_tier: tier };
}

/**
 * Rewrite a JSON request body string to carry `service_tier`.
 * Returns the replacement body, or `undefined` when the body must be left
 * untouched (not JSON, not an object, or already carrying the tier).
 */
export function injectServiceTierIntoBody(
	bodyText: string,
	tier: string,
): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyText);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		return undefined;
	if ((parsed as Record<string, unknown>).service_tier === tier)
		return undefined;
	return JSON.stringify(injectServiceTier(parsed, tier));
}

/**
 * Rewrite an outgoing JSON request to carry `service_tier`.
 * Returns the replacement `Request`, or `undefined` when the original must
 * be left untouched (no tier selected, non-JSON body, unparsable or
 * non-object JSON, or the tier already present). The original request is
 * never consumed: the body is read from a clone.
 */
export async function withServiceTier(
	request: Request,
	tier: string | null,
): Promise<Request | undefined> {
	if (tier === null) return undefined;
	if (request.method === "GET" || request.method === "HEAD") return undefined;
	const contentType = request.headers.get("content-type");
	if (!contentType?.includes("application/json")) return undefined;
	let text: string;
	try {
		text = await request.clone().text();
	} catch {
		return undefined;
	}
	if (text === "") return undefined;
	const replacement = injectServiceTierIntoBody(text, tier);
	if (replacement === undefined) return undefined;
	// Forward headers except content-length: the replacement body has a
	// different byte length and a stale content-length would truncate it.
	const headers = new Headers(request.headers);
	headers.delete("content-length");
	return new Request(request.url, {
		method: request.method,
		headers,
		body: replacement,
	});
}

// ---------------------------------------------------------------------------
// Status text (slash-command replies)
// ---------------------------------------------------------------------------

function formatTiers(policy: PlexusModelPolicy | undefined): string {
	if (!policy || policy.serviceTiers.length === 0) return "no service tiers";
	return policy.serviceTiers.join(", ");
}

function formatBudget(policy: PlexusModelPolicy | undefined): string {
	if (
		policy?.shortContextBudgetTokens === undefined ||
		policy.maxContextTokens === undefined
	)
		return "no context budget";
	return `short ${policy.shortContextBudgetTokens} / max ${policy.maxContextTokens}`;
}

/** Reply text for `/plexus-tier [status]`: session selection + advertisement. */
export function formatTierStatus(
	modelID: string,
	selection: PolicySelection,
	policy: PlexusModelPolicy | undefined,
): string {
	const active = selection.serviceTier ?? "default (provider default)";
	return (
		`Plexus service tier for ${modelID} (this session): ${active}. ` +
		`Advertised tiers: ${formatTiers(policy)}. ` +
		`Change with /plexus-tier <tier|default>.`
	);
}

/** Reply text for `/plexus-context [status]`: session selection + advertisement. */
export function formatContextStatus(
	modelID: string,
	selection: PolicySelection,
	policy: PlexusModelPolicy | undefined,
	effectiveWindow: number | undefined,
): string {
	const mode = selection.longContext ? "max" : "short";
	const window =
		effectiveWindow === undefined ? "unknown" : String(effectiveWindow);
	return (
		`Plexus context for ${modelID} (this session): ${mode} (${window} tokens). ` +
		`Advertised budget: ${formatBudget(policy)}. ` +
		`Change with /plexus-context <short|max>.`
	);
}

// ---------------------------------------------------------------------------
// Command argument parsing (args arrive as `CommandInvocation.prompt.text`)
// ---------------------------------------------------------------------------

export type TierCommand =
	| { kind: "status" }
	| { kind: "clear" }
	| { kind: "select"; tier: string };

export type ContextCommand =
	| { kind: "status" }
	| { kind: "short" }
	| { kind: "max" }
	| { kind: "invalid"; value: string };

function firstToken(text: string | undefined): string {
	return (text ?? "").trim().split(/\s+/)[0] ?? "";
}

/**
 * Parse `/plexus-tier [tier|default|status]`. Bare invocation reports status.
 * Keywords match case-insensitively; tier names are kept verbatim
 * (case-sensitive) for advertisement comparison. Only the first token is
 * significant; extras are ignored.
 */
export function parseTierCommand(text: string | undefined): TierCommand {
	const arg = firstToken(text);
	if (arg === "" || arg.toLowerCase() === "status") return { kind: "status" };
	if (arg.toLowerCase() === "default") return { kind: "clear" };
	return { kind: "select", tier: arg };
}

/**
 * Parse `/plexus-context [short|max|status]`. Bare invocation reports
 * status. Keywords match case-insensitively; anything else is invalid
 * (context has no free-form values — never fabricate a budget).
 */
export function parseContextCommand(text: string | undefined): ContextCommand {
	const arg = firstToken(text);
	if (arg === "" || arg.toLowerCase() === "status") return { kind: "status" };
	if (arg.toLowerCase() === "short") return { kind: "short" };
	if (arg.toLowerCase() === "max") return { kind: "max" };
	return { kind: "invalid", value: arg };
}

// ---------------------------------------------------------------------------
// Session-scoped selection store
// ---------------------------------------------------------------------------

interface SessionEntry {
	boundModel: PolicyModelRef;
	selection: PolicySelection;
}

export type ReconcileChangeKind =
	| "tier-cleared"
	| "context-reset-max"
	| "short-lowered";

export interface SessionReconcileChange {
	sessionID: string;
	modelID: string;
	kind: ReconcileChangeKind;
	detail: string;
}

export type SelectResult =
	| { ok: true; selection: PolicySelection }
	| { ok: false; reason: string; selection: PolicySelection };

function sameModel(a: PolicyModelRef, b: PolicyModelRef): boolean {
	return a.providerID === b.providerID && a.id === b.id;
}

function validateSelection(
	policy: PlexusModelPolicy | undefined,
	patch: { longContext?: boolean; serviceTier?: string | null },
): string | undefined {
	if (patch.longContext === false) {
		if (
			policy?.shortContextBudgetTokens === undefined ||
			policy.maxContextTokens === undefined
		)
			return "No context budget is advertised for the active model.";
		if (policy.shortContextBudgetTokens >= policy.maxContextTokens) {
			return "The active model has no distinct short and maximum context budget.";
		}
	}
	if (patch.serviceTier !== undefined && patch.serviceTier !== null) {
		if (!policy?.serviceTiers.includes(patch.serviceTier)) {
			return "The requested service tier is not advertised for the active model.";
		}
	}
	return undefined;
}

/**
 * Owns per-session policy selections plus the committed catalog
 * advertisement. All operations are synchronous and side-effect free except
 * the store itself; hook and command layers in `plugin.ts` compose these
 * primitives with the opencode SDK.
 */
export class SessionPolicyStore {
	private catalog = new Map<string, PlexusModelPolicy>();
	private sessions = new Map<string, SessionEntry>();

	/** Rebuild the advertisement from the committed catalog and reconcile. */
	setCatalog(models: readonly PlexusModelInfo[]): SessionReconcileChange[] {
		const previous = this.catalog;
		const next = new Map<string, PlexusModelPolicy>();
		for (const model of models) {
			if (model.policy) next.set(model.id, model.policy);
		}
		this.catalog = next;
		return this.reconcile(previous);
	}

	policyFor(modelID: string): PlexusModelPolicy | undefined {
		return this.catalog.get(modelID);
	}

	/** Last model bound to a session by hooks/commands, if any. */
	lastBoundModel(sessionID: string): PolicyModelRef | undefined {
		const entry = this.sessions.get(sessionID);
		return entry ? { ...entry.boundModel } : undefined;
	}

	/**
	 * Bind a session to a model, resetting to defaults when the model
	 * changed. Returns `true` when a reset occurred. Sessions with no entry
	 * are bound silently (no reset).
	 */
	ensureBound(sessionID: string, model: PolicyModelRef): boolean {
		const entry = this.sessions.get(sessionID);
		if (!entry) {
			this.sessions.set(sessionID, {
				boundModel: { providerID: model.providerID, id: model.id },
				selection: defaultSelection(),
			});
			return false;
		}
		if (sameModel(entry.boundModel, model)) return false;
		entry.boundModel = { providerID: model.providerID, id: model.id };
		entry.selection = defaultSelection();
		return true;
	}

	/**
	 * Validate the full patch before applying anything: rejection is
	 * atomic — a failing patch leaves the stored selection untouched.
	 */
	select(
		sessionID: string,
		model: PolicyModelRef,
		patch: { longContext?: boolean; serviceTier?: string | null },
	): SelectResult {
		this.ensureBound(sessionID, model);
		const entry = this.sessions.get(sessionID);
		if (!entry) {
			const selection = defaultSelection();
			return { ok: false, reason: "No session selection.", selection };
		}
		const policy = this.catalog.get(entry.boundModel.id);
		const reason = validateSelection(policy, patch);
		if (reason !== undefined) {
			return { ok: false, reason, selection: { ...entry.selection } };
		}
		if (patch.longContext !== undefined)
			entry.selection.longContext = patch.longContext;
		if (patch.serviceTier !== undefined)
			entry.selection.serviceTier = patch.serviceTier;
		return { ok: true, selection: { ...entry.selection } };
	}

	status(
		sessionID: string,
		model: PolicyModelRef,
	): {
		selection: PolicySelection;
		policy: PlexusModelPolicy | undefined;
		available: PolicyAvailability;
		effectiveWindow: number | undefined;
		reset: boolean;
	} {
		const reset = this.ensureBound(sessionID, model);
		const entry = this.sessions.get(sessionID);
		const selection = entry ? { ...entry.selection } : defaultSelection();
		const policy = this.catalog.get(model.id);
		return {
			selection,
			policy,
			available: policyAvailability(policy),
			effectiveWindow: effectiveContextWindow(policy, selection),
			reset,
		};
	}

	/** Active tier for a request, or `null` when none applies. Never throws. */
	tierForRequest(sessionID: string, model: PolicyModelRef): string | null {
		try {
			this.ensureBound(sessionID, model);
			const entry = this.sessions.get(sessionID);
			if (!entry || !sameModel(entry.boundModel, model)) return null;
			const policy = this.catalog.get(entry.boundModel.id);
			if (!policy || policy.serviceTiers.length === 0) return null;
			const tier = entry.selection.serviceTier;
			if (tier === null || !policy.serviceTiers.includes(tier)) return null;
			return tier;
		} catch {
			return null;
		}
	}

	/** Effective context window for a request, or `undefined` without a policy. */
	contextBudgetForRequest(
		sessionID: string,
		model: PolicyModelRef,
	): number | undefined {
		try {
			this.ensureBound(sessionID, model);
			const entry = this.sessions.get(sessionID);
			if (!entry || !sameModel(entry.boundModel, model)) return undefined;
			return effectiveContextWindow(
				this.catalog.get(entry.boundModel.id),
				entry.selection,
			);
		} catch {
			return undefined;
		}
	}

	/**
	 * Apply the session's effective budget to hook `options`. The budget is
	 * carried in {@link CONTEXT_BUDGET_OPTION}; the key is removed when the
	 * session's model advertises no context policy. Never touches shared
	 * model definitions.
	 */
	applyToOptions(
		options: Record<string, unknown>,
		sessionID: string,
		model: PolicyModelRef,
	): void {
		const budget = this.contextBudgetForRequest(sessionID, model);
		if (budget === undefined) delete options[CONTEXT_BUDGET_OPTION];
		else options[CONTEXT_BUDGET_OPTION] = budget;
	}

	/**
	 * Re-evaluate every session against the current catalog (port of pi's
	 * `PolicyController.reconcile`). Returns the changes applied, for
	 * logging; sessions whose advertisement is unchanged are untouched.
	 */
	reconcile(
		previous?: Map<string, PlexusModelPolicy>,
	): SessionReconcileChange[] {
		const changes: SessionReconcileChange[] = [];
		for (const [sessionID, entry] of this.sessions) {
			const policy = this.catalog.get(entry.boundModel.id);
			const before = { ...entry.selection };
			// The pre-refresh window comes from the previous advertisement:
			// comparing against the new one detects lowered short budgets.
			const beforeWindow = effectiveContextWindow(
				previous?.get(entry.boundModel.id) ?? policy,
				before,
			);
			let reason: string | undefined;

			if (policy?.shortContextBudgetTokens === undefined) {
				if (!entry.selection.longContext) {
					entry.selection.longContext = true;
					reason =
						"The active model no longer advertises a short context budget.";
				}
			} else if (
				policy.shortContextBudgetTokens >=
					(policy.maxContextTokens as number) &&
				!entry.selection.longContext
			) {
				entry.selection.longContext = true;
				reason =
					"The active model no longer advertises a distinct short context budget.";
			}
			if (entry.selection.serviceTier !== null) {
				if (!policy?.serviceTiers.includes(entry.selection.serviceTier)) {
					entry.selection.serviceTier = null;
					reason =
						"The selected service tier is no longer advertised for the active model.";
				}
			}

			const afterWindow = effectiveContextWindow(policy, entry.selection);
			const tierChanged = entry.selection.serviceTier !== before.serviceTier;
			const contextChanged = entry.selection.longContext !== before.longContext;
			if (tierChanged) {
				changes.push({
					sessionID,
					modelID: entry.boundModel.id,
					kind: "tier-cleared",
					detail: reason ?? "Service tier selection cleared.",
				});
			}
			if (contextChanged) {
				changes.push({
					sessionID,
					modelID: entry.boundModel.id,
					kind: "context-reset-max",
					detail: reason ?? "Context selection reset to the maximum budget.",
				});
			}
			if (
				!entry.selection.longContext &&
				beforeWindow !== undefined &&
				afterWindow !== undefined &&
				afterWindow !== beforeWindow
			) {
				changes.push({
					sessionID,
					modelID: entry.boundModel.id,
					kind: "short-lowered",
					detail: `Short context budget changed ${beforeWindow} -> ${afterWindow}; re-applied.`,
				});
			}
		}
		return changes;
	}
}
