import type { ContextPolicy } from "./context-policy.ts";
import type { ServiceTierPolicy } from "./service-tiers.ts";

/**
 * In-process Plexus policy engine for one session.
 *
 * It applies the advertised context budget to the session-local model and
 * exposes the selected service tier for request injection. The selection comes
 * from a resolver: terminal sessions use the default (maximum budget, no tier);
 * the Plexus root control module installs its own resolver once activated.
 */

export interface PolicyModel {
	provider: string;
	id: string;
}

export interface PolicySelection {
	/** `true` selects the advertised maximum context budget, `false` the short budget. */
	longContext: boolean;
	/** The advertised service tier to inject, or `null` for none. */
	serviceTier: string | null;
}

export interface PolicyAdvertisement {
	context?: ContextPolicy;
	serviceTier?: ServiceTierPolicy;
}

export interface PolicyAvailability {
	longContext: boolean;
	serviceTier: boolean;
}

export interface PolicyHost {
	/** The active session model identity, or `undefined` when none is a Plexus model. */
	getActiveModel(): PolicyModel | undefined;
	/** The committed advertisement for the model, or `undefined` when none exists. */
	getAdvertisement(model: PolicyModel): PolicyAdvertisement | undefined;
	/** The catalog context window for the model, or `undefined` when unknown. */
	getCatalogContextWindow(model: PolicyModel): number | undefined;
	/** Whether any catalog model carries a context policy. */
	hasCatalogContextPolicy(): boolean;
	/**
	 * Apply a session-scoped context window to the active model. `undefined`
	 * restores the catalog model. Returns the effective window, or `undefined`
	 * when the override could not be applied. Never persists.
	 */
	applyContextWindow(
		model: PolicyModel,
		contextWindow: number | undefined,
	): Promise<number | undefined>;
}

/** Chooses the selection to apply for the active model and its advertisement. */
export type PolicyResolver = (
	model: PolicyModel | undefined,
	advertisement: PolicyAdvertisement | undefined,
) => PolicySelection;

/** The last applied state for the session. */
export interface PolicyView {
	readonly model: PolicyModel | undefined;
	readonly selection: PolicySelection;
	readonly available: PolicyAvailability;
	/** The effective context window when the model advertises a context policy. */
	readonly contextWindow: number | undefined;
	/** The most recent budget application failed and the previous budget is kept. */
	readonly applyFailed: boolean;
}

/** Whether the advertisement exposes a distinct short/max context budget and any service tiers. */
export function policyAvailability(
	advertisement: PolicyAdvertisement | undefined,
): PolicyAvailability {
	const context = advertisement?.context;
	return {
		longContext:
			context !== undefined &&
			context.shortContextBudgetTokens < context.maxContextTokens,
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
	if (
		!selection.longContext &&
		context.shortContextBudgetTokens < context.maxContextTokens
	) {
		return context.shortContextBudgetTokens;
	}
	return context.maxContextTokens;
}

/** Injects `service_tier` into a request payload, leaving non-object payloads untouched. */
export function injectServiceTier(
	payload: unknown,
	tier: string | null | undefined,
): unknown {
	if (tier === null || tier === undefined) return payload;
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		return payload;
	return { ...(payload as Record<string, unknown>), service_tier: tier };
}

const TERMINAL_RESOLVER: PolicyResolver = () => ({
	longContext: true,
	serviceTier: null,
});

function sameModel(
	a: PolicyModel | undefined,
	b: PolicyModel | undefined,
): boolean {
	return (
		a !== undefined &&
		b !== undefined &&
		a.provider === b.provider &&
		a.id === b.id
	);
}

const EMPTY_VIEW: PolicyView = Object.freeze({
	model: undefined,
	selection: Object.freeze({ longContext: false, serviceTier: null }),
	available: Object.freeze({ longContext: false, serviceTier: false }),
	contextWindow: undefined,
	applyFailed: false,
});

/** Applies the resolved selection to the active session model, one change at a time. */
export class PolicyController {
	private resolver: PolicyResolver | undefined;
	private view: PolicyView = EMPTY_VIEW;
	private readonly listeners = new Set<() => void>();
	private chain: Promise<void> = Promise.resolve();

	constructor(private readonly host: PolicyHost) {}

	getView(): PolicyView {
		return this.view;
	}

	/** Install the selection resolver, or `undefined` to return to the terminal default. */
	setResolver(resolver: PolicyResolver | undefined): void {
		this.resolver = resolver;
	}

	/** Notified after every applied recompute, including unchanged results. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** The tier to inject for a request model, or `null` when none applies. */
	serviceTierFor(model: PolicyModel | undefined): string | null {
		if (!model || !sameModel(this.view.model, model)) return null;
		return this.view.selection.serviceTier;
	}

	/** Re-evaluate the active model and re-apply the selection. */
	reconcile(): Promise<void> {
		return this.enqueue(() => this.recompute());
	}

	private enqueue(task: () => Promise<void>): Promise<void> {
		const run = this.chain.then(task, task).catch(() => undefined);
		this.chain = run;
		return run;
	}

	private async recompute(): Promise<void> {
		const model = this.host.getActiveModel();
		const advertisement =
			model === undefined ? undefined : this.host.getAdvertisement(model);
		const intent = (this.resolver ?? TERMINAL_RESOLVER)(model, advertisement);
		const available = policyAvailability(advertisement);
		const tiers = advertisement?.serviceTier?.serviceTiers ?? [];
		const same = sameModel(this.view.model, model);

		let selection: PolicySelection = {
			longContext: intent.longContext && available.longContext,
			serviceTier:
				intent.serviceTier !== null && tiers.includes(intent.serviceTier)
					? intent.serviceTier
					: null,
		};
		let contextWindow: number | undefined;
		let applyFailed = false;
		if (model !== undefined) {
			const applied = await this.applyContext(
				model,
				effectiveContextWindow(advertisement, selection),
			);
			if (advertisement?.context !== undefined) {
				if (applied === undefined) {
					// Keep the previously applied budget and report the failure.
					applyFailed = true;
					selection = {
						...selection,
						longContext: same ? this.view.selection.longContext : false,
					};
					contextWindow = same ? this.view.contextWindow : undefined;
				} else {
					contextWindow = applied;
				}
			}
		}

		this.view = Object.freeze({
			model,
			selection: Object.freeze(selection),
			available: Object.freeze(available),
			contextWindow,
			applyFailed,
		});
		for (const listener of [...this.listeners]) listener();
	}

	private async applyContext(
		model: PolicyModel,
		contextWindow: number | undefined,
	): Promise<number | undefined> {
		try {
			return await this.host.applyContextWindow(model, contextWindow);
		} catch {
			return undefined;
		}
	}
}
