import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ContextPolicy } from "./context-policy.ts";
import type { ServiceTierPolicy } from "./service-tiers.ts";

/**
 * Session-scoped Plexus policy control.
 *
 * `plexus-pi` owns the context-policy and service-tier advertisement, so it also
 * exposes a control command that selects, for the active session and model,
 * which advertised context budget applies and which advertised service tier is
 * active. The selected state is published on the Pi event bus and applied to
 * requests and to the session's effective context window.
 *
 * The controller is host-agnostic: the extension supplies a {@link PolicyHost}
 * that resolves the active model, its advertisement, and the session-scoped
 * context-window application.
 */

export const POLICY_SET_CHANNEL = "plexus:policy:set:v1";
export const POLICY_STATE_CHANNEL = "plexus:policy:state:v1";

const MAX_STATE_BYTES = 1024 * 1024;

export const PolicySetSchema = z
	.object({
		version: z.literal(1),
		requestId: z.string().min(1).max(1024),
		longContext: z.boolean().optional(),
		serviceTier: z.string().min(1).max(100).nullable().optional(),
	})
	.strict()
	.refine(
		(command) => command.longContext !== undefined || command.serviceTier !== undefined,
		{ message: "At least one of longContext or serviceTier is required." },
	);

export const PolicyAppliedSchema = z
	.object({
		longContext: z.boolean(),
		serviceTier: z.string().min(1).max(100).nullable(),
		contextWindow: z.number().int().positive().safe().optional(),
	})
	.strict();

export const PolicyAvailabilitySchema = z
	.object({
		longContext: z.boolean(),
		serviceTier: z.boolean(),
	})
	.strict();

export const PolicyStateSchema = z
	.object({
		version: z.literal(1),
		publisherId: z.string().uuid(),
		revision: z.number().int().positive().safe(),
		requestId: z.string().min(1).max(1024).optional(),
		applied: PolicyAppliedSchema,
		available: PolicyAvailabilitySchema,
		reason: z.string().max(500).optional(),
	})
	.strict();

export type PolicySet = z.infer<typeof PolicySetSchema>;
export type PolicyApplied = z.infer<typeof PolicyAppliedSchema>;
export type PolicyAvailability = z.infer<typeof PolicyAvailabilitySchema>;
export type PolicyState = z.infer<typeof PolicyStateSchema>;
/** A published policy state, without a correlated `requestId`. */
export type PublishedPolicyState = Omit<PolicyState, "requestId">;

export interface PolicySelection {
	/** `true` selects the advertised maximum context budget, `false` the short budget. */
	longContext: boolean;
	/** The active advertised service tier, or `null` for the provider default. */
	serviceTier: string | null;
}

export interface PolicyAdvertisement {
	context?: ContextPolicy;
	serviceTier?: ServiceTierPolicy;
}

export interface PolicyHost {
	/** The active session model identity, or `undefined` when none is selected. */
	getActiveModel(): { provider: string; id: string } | undefined;
	/** The committed advertisement for the model, or `undefined` when none exists. */
	getAdvertisement(model: { provider: string; id: string }): PolicyAdvertisement | undefined;
	/** The session's current effective context window, or `undefined` when unknown. */
	getEffectiveContextWindow(): number | undefined;
	/**
	 * Apply a session-scoped context window to the active model. `contextWindow`
	 * of `undefined` restores the catalog model. Returns the effective window, or
	 * `undefined` when the override could not be applied. Never persists.
	 */
	applyContextWindow(
		model: { provider: string; id: string },
		contextWindow: number | undefined,
	): Promise<number | undefined>;
}

export const POLICY_UNAVAILABLE_REASON =
	"No Plexus context or service-tier policy is advertised for the active model.";

const DEFAULT_SELECTION: PolicySelection = Object.freeze({ longContext: true, serviceTier: null });

/** Whether the advertisement exposes a distinct short/max context budget and any service tiers. */
export function policyAvailability(advertisement: PolicyAdvertisement | undefined): PolicyAvailability {
	const context = advertisement?.context;
	return {
		longContext: context !== undefined && context.shortContextBudgetTokens < context.maxContextTokens,
		serviceTier: (advertisement?.serviceTier?.serviceTiers.length ?? 0) > 0,
	};
}

/** The context window the selection resolves to, or `undefined` when no context policy exists. */
export function effectiveContextWindow(
	advertisement: PolicyAdvertisement | undefined,
	selection: PolicySelection,
): number | undefined {
	const context = advertisement?.context;
	if (!context) return undefined;
	if (!selection.longContext && context.shortContextBudgetTokens < context.maxContextTokens) {
		return context.shortContextBudgetTokens;
	}
	return context.maxContextTokens;
}

/** Injects `service_tier` into a request payload, leaving non-object payloads untouched. */
export function injectServiceTier(payload: unknown, tier: string | null | undefined): unknown {
	if (tier === null || tier === undefined) return payload;
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	return { ...(payload as Record<string, unknown>), service_tier: tier };
}

const encoder = new TextEncoder();
function byteLength(value: unknown): number {
	return encoder.encode(JSON.stringify(value)).byteLength;
}

function freezeParsed(state: PolicyState): PolicyState {
	return Object.freeze({
		...state,
		applied: Object.freeze({ ...state.applied }),
		available: Object.freeze({ ...state.available }),
	}) as PolicyState;
}

function freezePublished(state: PublishedPolicyState): PublishedPolicyState {
	return Object.freeze({
		...state,
		applied: Object.freeze({ ...state.applied }),
		available: Object.freeze({ ...state.available }),
	}) as PublishedPolicyState;
}

function selectionStatesEqual(
	current: PublishedPolicyState,
	next: { applied: PolicyApplied; available: PolicyAvailability; reason?: string },
): boolean {
	const shape = (state: { applied: PolicyApplied; available: PolicyAvailability; reason?: string }) =>
		JSON.stringify({ applied: state.applied, available: state.available, reason: state.reason ?? null });
	return shape(current) === shape(next);
}

function validateSelection(
	model: { provider: string; id: string } | undefined,
	advertisement: PolicyAdvertisement | undefined,
	command: PolicySet,
): string | undefined {
	if (
		model === undefined ||
		advertisement === undefined ||
		(advertisement.context === undefined && advertisement.serviceTier === undefined)
	) {
		return POLICY_UNAVAILABLE_REASON;
	}
	if (command.longContext !== undefined) {
		const context = advertisement.context;
		if (context === undefined) return "No context budget is advertised for the active model.";
		if (context.shortContextBudgetTokens >= context.maxContextTokens) {
			return "The active model has no distinct short and maximum context budget.";
		}
	}
	if (command.serviceTier !== undefined && command.serviceTier !== null) {
		const tiers = advertisement.serviceTier?.serviceTiers;
		if (!tiers || !tiers.includes(command.serviceTier)) {
			return "The requested service tier is not advertised for the active model.";
		}
	}
	return undefined;
}

/**
 * Owns the versioned policy state and applies validated control commands.
 *
 * Requests are handled serially. A correlated reply never advances the revision;
 * a broadcast is emitted when the published state changes. Invalid or
 * unadvertised commands are rejected without partial application.
 */
export class PolicyController {
	readonly publisherId = randomUUID();
	private revision = 1;
	private selection: PolicySelection = { ...DEFAULT_SELECTION };
	private boundModel: { provider: string; id: string } | undefined;
	private available: PolicyAvailability = { longContext: false, serviceTier: false };
	private contextWindow: number | undefined;
	private reason: string | undefined;
	private state: PublishedPolicyState;
	private readonly emit: (channel: string, data: unknown) => void;
	private readonly unsubscribe: () => void;
	private chain: Promise<void> = Promise.resolve();

	constructor(
		events: {
			on(channel: string, handler: (data: unknown) => void): () => void;
			emit(channel: string, data: unknown): void;
		},
		private readonly host: PolicyHost,
	) {
		this.emit = events.emit.bind(events);
		this.state = freezePublished({
			version: 1,
			publisherId: this.publisherId,
			revision: 1,
			applied: { longContext: true, serviceTier: null },
			available: { longContext: false, serviceTier: false },
		});
		this.unsubscribe = events.on(POLICY_SET_CHANNEL, (data) => this.enqueue(() => this.handleSet(data)));
	}

	getState(): PublishedPolicyState {
		return this.state;
	}

	/** The active tier to inject for a request model, or `null` when none applies. */
	serviceTierFor(model: { provider: string; id: string } | undefined): string | null {
		if (!model || !this.boundModel) return null;
		if (this.boundModel.provider !== model.provider || this.boundModel.id !== model.id) return null;
		if (!this.available.serviceTier) return null;
		return this.selection.serviceTier;
	}

	/** Re-evaluate the active model's advertisement and re-apply the selection. */
	reconcile(): Promise<void> {
		return this.enqueue(() => this.recompute());
	}

	dispose(): void {
		this.unsubscribe();
	}

	private enqueue(task: () => Promise<void>): Promise<void> {
		const run = this.chain.then(task, task).catch(() => undefined);
		this.chain = run;
		return run;
	}

	private async recompute(): Promise<void> {
		const model = this.host.getActiveModel();
		if (model === undefined) {
			this.commit({
				selection: { ...DEFAULT_SELECTION },
				boundModel: undefined,
				available: { longContext: false, serviceTier: false },
				contextWindow: undefined,
				reason: POLICY_UNAVAILABLE_REASON,
			});
			return;
		}

		const advertisement = this.host.getAdvertisement(model);
		const sameModel =
			this.boundModel?.provider === model.provider && this.boundModel.id === model.id;
		let selection: PolicySelection = sameModel ? { ...this.selection } : { ...DEFAULT_SELECTION };
		let reason: string | undefined;
		const available = policyAvailability(advertisement);

		if (advertisement?.context === undefined) {
			if (!selection.longContext) {
				selection = { ...selection, longContext: true };
				reason = "The active model no longer advertises a short context budget.";
			}
		} else if (!available.longContext && !selection.longContext) {
			selection = { ...selection, longContext: true };
			reason = "The active model no longer advertises a distinct short context budget.";
		}
		if (selection.serviceTier !== null) {
			const tiers = advertisement?.serviceTier?.serviceTiers;
			if (!tiers || !tiers.includes(selection.serviceTier)) {
				selection = { ...selection, serviceTier: null };
				reason = "The selected service tier is no longer advertised for the active model.";
			}
		}
		if (advertisement?.context === undefined && advertisement?.serviceTier === undefined) {
			reason = POLICY_UNAVAILABLE_REASON;
		}

		const desired = effectiveContextWindow(advertisement, selection);
		const appliedWindow = await this.applyContext(model, desired);
		if (advertisement?.context !== undefined && appliedWindow === undefined) {
			reason = "The session context window could not be updated.";
		}

		this.commit({
			selection,
			boundModel: model,
			available,
			contextWindow: advertisement?.context !== undefined ? appliedWindow : undefined,
			reason,
		});
	}

	private async handleSet(data: unknown): Promise<void> {
		const parsed = PolicySetSchema.safeParse(data);
		if (!parsed.success) return;
		const command = parsed.data;

		const model = this.host.getActiveModel();
		const advertisement = model === undefined ? undefined : this.host.getAdvertisement(model);
		const sameModel =
			model !== undefined &&
			this.boundModel?.provider === model.provider &&
			this.boundModel.id === model.id;
		const current: PolicySelection = sameModel ? { ...this.selection } : { ...DEFAULT_SELECTION };
		const nextSelection: PolicySelection = {
			longContext: command.longContext ?? current.longContext,
			serviceTier: command.serviceTier === undefined ? current.serviceTier : command.serviceTier,
		};

		const rejection = validateSelection(model, advertisement, command);
		if (rejection !== undefined) {
			this.emitReply(command.requestId, rejection);
			return;
		}

		const desired = effectiveContextWindow(advertisement, nextSelection);
		const appliedWindow = model === undefined ? undefined : await this.applyContext(model, desired);
		if (advertisement?.context !== undefined && appliedWindow === undefined) {
			this.emitReply(command.requestId, "The session context window could not be updated.");
			return;
		}

		this.commit(
			{
				selection: nextSelection,
				boundModel: model,
				available: policyAvailability(advertisement),
				contextWindow: advertisement?.context !== undefined ? appliedWindow : undefined,
				reason: undefined,
			},
			command.requestId,
		);
	}

	private async applyContext(
		model: { provider: string; id: string },
		contextWindow: number | undefined,
	): Promise<number | undefined> {
		try {
			return await this.host.applyContextWindow(model, contextWindow);
		} catch {
			return undefined;
		}
	}

	private commit(
		next: {
			selection: PolicySelection;
			boundModel: { provider: string; id: string } | undefined;
			available: PolicyAvailability;
			contextWindow: number | undefined;
			reason: string | undefined;
		},
		requestId?: string,
	): void {
		this.selection = next.selection;
		this.boundModel = next.boundModel;
		this.available = next.available;
		this.contextWindow = next.contextWindow;
		this.reason = next.reason;

		const candidate = {
			applied: {
				longContext: next.selection.longContext,
				serviceTier: next.selection.serviceTier,
				...(next.contextWindow === undefined ? {} : { contextWindow: next.contextWindow }),
			},
			available: { ...next.available },
			...(next.reason === undefined ? {} : { reason: next.reason }),
		};

		const changed = !selectionStatesEqual(this.state, candidate);
		if (changed) {
			this.revision++;
			this.state = freezePublished({
				version: 1,
				publisherId: this.publisherId,
				revision: this.revision,
				...candidate,
			});
			this.emitState(this.state);
		}
		if (requestId !== undefined) {
			this.emitState(this.state, requestId);
		}
	}

	private emitReply(requestId: string, reason: string | undefined): void {
		const parsed = PolicyStateSchema.safeParse({
			...this.state,
			...(reason === undefined ? {} : { reason }),
			requestId,
		});
		if (parsed.success && byteLength(parsed.data) <= MAX_STATE_BYTES) {
			this.emit(POLICY_STATE_CHANNEL, freezeParsed(parsed.data));
		}
	}

	private emitState(state: PublishedPolicyState, requestId?: string): void {
		const candidate = requestId === undefined ? state : { ...state, requestId };
		const parsed = PolicyStateSchema.safeParse(candidate);
		if (parsed.success && byteLength(parsed.data) <= MAX_STATE_BYTES) {
			this.emit(POLICY_STATE_CHANNEL, freezeParsed(parsed.data));
			return;
		}
		const fallback = PolicyStateSchema.safeParse({
			version: 1,
			publisherId: this.publisherId,
			revision: this.revision,
			...(requestId === undefined ? {} : { requestId }),
			applied: { longContext: true, serviceTier: null },
			available: { longContext: false, serviceTier: false },
			reason: "Plexus policy state is unavailable.",
		});
		if (fallback.success) this.emit(POLICY_STATE_CHANNEL, freezeParsed(fallback.data));
	}
}
