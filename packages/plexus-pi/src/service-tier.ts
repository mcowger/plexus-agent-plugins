/**
 * Service-tier selection for Plexus models.
 *
 * The active tier is a per-session preference set through the /service-tier
 * command. When a request is sent to a model whose API dialect and family
 * support the active tier, the tier is injected into the provider payload
 * (e.g. `service_tier: "flex"` for OpenAI Responses models).
 *
 * The mapping is expressed as a small registry of {@link ServiceTierDialect}s,
 * one per provider API family, so additional APIs/services can be added later
 * without touching the command or the request hook.
 */

export type ServiceTier = "default" | "priority" | "flex" | "ultrafast";
export type ActiveServiceTier = Exclude<ServiceTier, "default">;

/** Canonical tiers in display order. */
export const SERVICE_TIERS: readonly ServiceTier[] = ["default", "priority", "flex", "ultrafast"];

/** User-facing aliases (the Paseo pill sends `fast`). */
const TIER_ALIASES: Readonly<Record<string, ServiceTier>> = {
	default: "default",
	off: "default",
	none: "default",
	priority: "priority",
	fast: "priority",
	flex: "flex",
	ultrafast: "ultrafast",
};

export function parseServiceTierArg(input: string): ServiceTier | undefined {
	return TIER_ALIASES[input.trim().toLowerCase()];
}

/** Minimal model shape needed to decide whether a tier applies. */
export interface ServiceTierModel {
	provider: string;
	api: string;
	id: string;
}

/**
 * One provider API family's tier behavior.
 *
 * A dialect owns the API names it applies to, the set of non-default tiers it
 * can request, the model families it recognizes, and the payload field it
 * writes. New APIs/services add a dialect rather than special-casing the hook.
 */
export interface ServiceTierDialect {
	/** Stable identifier, used for diagnostics. */
	readonly id: string;
	/** Provider API dialects this applies to (e.g. "openai-responses"). */
	readonly apis: readonly string[];
	/** Non-default tiers this dialect knows how to request. */
	readonly tiers: readonly ActiveServiceTier[];
	/** Whether the dialect recognizes this model family at all. */
	supportsModel(modelId: string): boolean;
	/** Whether this specific model supports a non-default tier. */
	supportsTier(modelId: string, tier: ActiveServiceTier): boolean;
	/** Merge the tier's request fields into a copy of the payload. */
	inject(
		payload: Record<string, unknown>,
		modelId: string,
		tier: ActiveServiceTier,
	): Record<string, unknown>;
}

// --- OpenAI Responses dialects ---------------------------------------------

const OPENAI_RESPONSES_APIS = ["openai-responses", "openai-codex-responses"] as const;

// `gpt-<major>[.<minor>]`, anchored to the start and followed by a `-` suffix
// or the end. Matches gpt-5.5, gpt-5.6-sol, gpt-6-astra, gpt-6.1-*, gpt-6,
// gpt-4.1-mini.
const GPT_VERSION = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/i;

// Fast/priority pricing covers families that predate the GPT 5.5+ core:
// GPT-4o and the o3 / o4-mini reasoning models.
const PRIORITY_EXTRA_FAMILIES = [/^gpt-4o(?=$|-)/i, /^o3(?=$|-)/i, /^o4-mini(?=$|-)/i];

/**
 * Whether OpenAI lists this model for Fast/priority processing: GPT-5 and
 * newer (any minor), GPT-4.1 and newer, plus the GPT-4o and o3/o4-mini
 * families. Deliberately broad per OpenAI's Fast-mode price table; tighten
 * here if a model rejects the tier. Snapshots and suffixes are allowed.
 */
export function isPriorityEligible(modelId: string): boolean {
	const id = modelId.trim();
	const match = GPT_VERSION.exec(id);
	if (match) {
		const major = Number(match[1]);
		const minor = match[2] === undefined ? 0 : Number(match[2]);
		return major >= 5 || (major === 4 && minor >= 1);
	}
	return PRIORITY_EXTRA_FAMILIES.some((pattern) => pattern.test(id));
}

// Flex: any GPT-5.5+ model (GPT-6 flagship pages price Flex; 5.5/5.6 verified).
function isFlexEligible(modelId: string): boolean {
	const match = GPT_VERSION.exec(modelId.trim());
	if (!match) return false;
	const major = Number(match[1]);
	const minor = match[2] === undefined ? 0 : Number(match[2]);
	return major > 5 || (major === 5 && minor >= 5);
}

// Ultrafast: GPT-6 Astra (incl. dotted minors) and GPT-5.6 Sol. Snapshots and
// suffixes are allowed after the variant name (gpt-6-astra-2025-08-01).
const ULTRAFAST_FAMILIES = [/^gpt-6(?:\.\d+)?-astra(?=$|-)/i, /^gpt-5\.6-sol(?=$|-)/i];

const OPENAI_RESPONSES_DIALECT: ServiceTierDialect = {
	id: "openai-responses",
	apis: OPENAI_RESPONSES_APIS,
	tiers: ["priority", "flex", "ultrafast"],
	supportsModel: isPriorityEligible,
	supportsTier(modelId, tier) {
		switch (tier) {
			case "priority":
				return isPriorityEligible(modelId);
			case "flex":
				return isFlexEligible(modelId);
			case "ultrafast":
				return ULTRAFAST_FAMILIES.some((pattern) => pattern.test(modelId));
		}
	},
	inject(payload, _modelId, tier) {
		return { ...payload, service_tier: tier };
	},
};

// --- Anthropic Messages dialect --------------------------------------------

// Claude Fast mode is a research-preview beta: it needs both `speed: "fast"`
// in the body and the `fast-mode-2026-02-01` beta flag, which the Anthropic SDK
// turns into the `anthropic-beta` header. Appending to the params `betas` array
// (rather than mutating headers) preserves the betas pi-ai already computed.
// First-party Claude API only; available on these models.
const ANTHROPIC_MESSAGES_APIS = ["anthropic-messages"] as const;
const ANTHROPIC_FAST_MODE_BETA = "fast-mode-2026-02-01";
const CLAUDE_FAST_FAMILIES = [/^claude-opus-5(?=$|-)/i, /^claude-opus-4-8(?=$|-)/i];

const ANTHROPIC_MESSAGES_DIALECT: ServiceTierDialect = {
	id: "anthropic-messages",
	apis: ANTHROPIC_MESSAGES_APIS,
	tiers: ["priority"],
	supportsModel(modelId) {
		return /^claude-/i.test(modelId.trim());
	},
	supportsTier(modelId, tier) {
		return (
			tier === "priority" &&
			CLAUDE_FAST_FAMILIES.some((pattern) => pattern.test(modelId.trim()))
		);
	},
	inject(payload, _modelId, _tier) {
		const existing = Array.isArray(payload.betas)
			? payload.betas.filter((beta): beta is string => typeof beta === "string")
			: [];
		const betas = existing.includes(ANTHROPIC_FAST_MODE_BETA)
			? existing
			: [...existing, ANTHROPIC_FAST_MODE_BETA];
		return { ...payload, speed: "fast", betas };
	},
};

/** Every registered dialect. Add new APIs/services here. */
export const SERVICE_TIER_DIALECTS: readonly ServiceTierDialect[] = [
	OPENAI_RESPONSES_DIALECT,
	ANTHROPIC_MESSAGES_DIALECT,
];

export function dialectForApi(
	api: string | undefined,
	dialects: readonly ServiceTierDialect[] = SERVICE_TIER_DIALECTS,
): ServiceTierDialect | undefined {
	if (!api) return undefined;
	return dialects.find((dialect) => dialect.apis.includes(api));
}

/** Whether the model's dialect recognizes and can request the active tier. */
export function isTierSupportedByModel(
	model: ServiceTierModel | undefined,
	tier: ServiceTier,
	dialects: readonly ServiceTierDialect[] = SERVICE_TIER_DIALECTS,
): boolean {
	if (tier === "default") return true;
	if (!model) return false;
	const dialect = dialectForApi(model.api, dialects);
	if (!dialect || !dialect.supportsModel(model.id)) return false;
	return dialect.supportsTier(model.id, tier);
}

export interface ApplyServiceTierOptions {
	/** Provider this extension owns; other providers are left untouched. */
	provider: string;
	dialects?: readonly ServiceTierDialect[];
}

/**
 * Injects the active tier into a provider payload when the model's dialect and
 * family support it. Returns the original payload unchanged otherwise.
 */
export function applyServiceTier(
	payload: unknown,
	model: ServiceTierModel | undefined,
	tier: ServiceTier,
	options: ApplyServiceTierOptions,
): unknown {
	if (tier === "default" || !model || model.provider !== options.provider) return payload;

	const dialect = dialectForApi(model.api, options.dialects);
	if (!dialect || !dialect.supportsModel(model.id) || !dialect.supportsTier(model.id, tier)) {
		return payload;
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;

	return dialect.inject(payload as Record<string, unknown>, model.id, tier);
}

// --- Notification ----------------------------------------------------------

export const SERVICE_TIER_NOTIFICATION_TYPE = "plexus.serviceTier";
export const SERVICE_TIER_COMMAND = "service-tier";

export interface ServiceTierNotificationInput {
	tier: ServiceTier;
	success: boolean;
	supported: boolean;
	provider: string;
	model: string;
}

/**
 * Builds the JSON string surfaced through ctx.ui.notify. Paseo parses this and
 * renders it as a timeline notification, so the shape is intentionally stable.
 */
export function buildServiceTierNotification(input: ServiceTierNotificationInput): string {
	return JSON.stringify({
		type: SERVICE_TIER_NOTIFICATION_TYPE,
		command: SERVICE_TIER_COMMAND,
		success: input.success,
		tier: input.tier,
		supported: input.supported,
		provider: input.provider,
		model: input.model,
	});
}
