import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { ContextPolicy } from "../context-policy.ts";
import {
	type PolicyAdvertisement,
	PolicyController,
	type PolicyHost,
	type PolicyModel,
} from "../policy.ts";
import type { ServiceTierPolicy } from "../service-tiers.ts";
import { createPlexuspiControl, type PaseoControlOptions } from "./control.ts";
import {
	NOTIFY_PREFIX,
	type PlexuspiReply,
	PlexuspiReplySchema,
} from "./protocol.ts";

export const KEY = "key-1";

export interface FakeModel {
	id: string;
	api: string;
	contextWindow: number;
	provider?: string;
}

export interface FakeNotify {
	message: string;
	level?: string;
}

export interface FakePiSeed {
	registry?: FakeModel[];
	policies?: ContextPolicy[];
	tierPolicies?: ServiceTierPolicy[];
	commands?: Array<{ name: string; source?: string }>;
}

/** Every Pi event handler under test takes `(event-or-payload, ctx)`. */
type Handler = (payload: unknown, ctx: unknown) => unknown;

export interface FakePi {
	api: ExtensionAPI;
	entries: Array<{ customType: string; data: unknown }>;
	handlers: Map<string, Handler[]>;
	channels: Map<string, Set<(data: unknown) => void>>;
	commands: Map<
		string,
		(args: string, ctx: ExtensionCommandContext) => Promise<void> | void
	>;
	host: PolicyHost;
	/** The session-local model; `pi.setModel` changes it, the registry never does. */
	sessionModel: FakeModel | undefined;
	registry: FakeModel[];
	setModelCalls: FakeModel[];
	setModelRefuses: boolean;
	emitEvent(channel: string, data: unknown): void;
	fire(event: string, payload: unknown, ctx: unknown): Promise<void>;
	findModel(
		provider: string | undefined,
		modelId: string,
	): FakeModel | undefined;
}

/** Fake Pi that also implements the PolicyHost contract against its registry. */
export function createFakePi(seed: FakePiSeed = {}): FakePi {
	const registry = seed.registry ?? [];
	const policies = seed.policies ?? [];
	const tierPolicies =
		seed.tierPolicies ??
		registry
			.filter((model) => model.provider === "plexus")
			.map((model) => ({
				provider: "plexus",
				modelId: model.id,
				serviceTiers: ["auto", "standard", "flex", "priority", "ultrafast"],
			}));
	const entries: FakePi["entries"] = [];
	const handlers = new Map<string, Handler[]>();
	const channels = new Map<string, Set<(data: unknown) => void>>();
	const commands = new Map<
		string,
		(args: string, ctx: ExtensionCommandContext) => Promise<void> | void
	>();
	const commandList = (seed.commands ?? []).map((command) => ({ ...command }));
	const state = {
		sessionModel: undefined as FakeModel | undefined,
		setModelCalls: [] as FakeModel[],
		setModelRefuses: false,
	};

	const findModel = (provider: string | undefined, modelId: string) =>
		registry.find(
			(candidate) =>
				(candidate.provider ?? "test") === (provider ?? "test") &&
				candidate.id === modelId,
		);

	const findAdvertisement = (
		model: PolicyModel,
	): PolicyAdvertisement | undefined => {
		const context = policies.find(
			(policy) =>
				policy.provider === model.provider && policy.modelId === model.id,
		);
		const serviceTier = tierPolicies.find(
			(policy) =>
				policy.provider === model.provider && policy.modelId === model.id,
		);
		if (!context && !serviceTier) return undefined;
		return {
			...(context ? { context } : {}),
			...(serviceTier ? { serviceTier } : {}),
		};
	};

	const host: PolicyHost = {
		getActiveModel: () => {
			const model = state.sessionModel;
			return model?.provider === "plexus"
				? { provider: "plexus", id: model.id }
				: undefined;
		},
		getAdvertisement: findAdvertisement,
		getCatalogContextWindow: (model) =>
			findModel(model.provider, model.id)?.contextWindow,
		hasCatalogContextPolicy: () => policies.length > 0,
		async applyContextWindow(model, contextWindow) {
			const canonical = findModel(model.provider, model.id);
			if (!canonical) return undefined;
			const target =
				contextWindow === undefined
					? canonical
					: { ...canonical, contextWindow };
			const active = state.sessionModel;
			if (
				active?.id === target.id &&
				active.contextWindow === target.contextWindow
			) {
				return target.contextWindow;
			}
			state.setModelCalls.push(target);
			if (state.setModelRefuses) return undefined;
			state.sessionModel = target;
			return target.contextWindow;
		},
	};

	const api = {
		getCommands: () => [
			...commandList,
			...[...commands.keys()].map((name) => ({ name, source: "extension" })),
		],
		registerCommand: (
			name: string,
			options: {
				handler: (
					args: string,
					ctx: ExtensionCommandContext,
				) => Promise<void> | void;
			},
		) => {
			commands.set(name, options.handler);
		},
		appendEntry: (customType: string, data?: unknown) => {
			entries.push({ customType, data });
		},
		setModel: async (model: FakeModel) => {
			state.setModelCalls.push(model);
			if (state.setModelRefuses) return false;
			state.sessionModel = model;
			return true;
		},
		on: (event: string, handler: Handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => undefined;
		},
		events: {
			emit: (channel: string, data: unknown) => {
				for (const handler of channels.get(channel) ?? []) handler(data);
			},
			on: (channel: string, handler: (data: unknown) => void) => {
				const set = channels.get(channel) ?? new Set();
				set.add(handler);
				channels.set(channel, set);
				return () => set.delete(handler);
			},
		},
	};

	return {
		api: api as unknown as ExtensionAPI,
		entries,
		handlers,
		channels,
		commands,
		host,
		get sessionModel() {
			return state.sessionModel;
		},
		set sessionModel(value) {
			state.sessionModel = value;
		},
		registry,
		get setModelCalls() {
			return state.setModelCalls;
		},
		get setModelRefuses() {
			return state.setModelRefuses;
		},
		set setModelRefuses(value) {
			state.setModelRefuses = value;
		},
		emitEvent(channel, data) {
			for (const handler of channels.get(channel) ?? []) handler(data);
		},
		async fire(event, payload, ctx) {
			for (const handler of handlers.get(event) ?? [])
				await handler(payload, ctx);
		},
		findModel,
	};
}

export interface FakeContextSeed {
	pi?: FakePi;
	model?: FakeModel;
	sessionId?: string;
	branch?: Array<Record<string, unknown>>;
	idle?: boolean;
	navigateCancelled?: boolean;
	navigateThrows?: string;
	navigateLeafId?: string;
	leafId?: string;
	reloadThrows?: string;
}

export interface FakeContext {
	ctx: ExtensionCommandContext;
	notifies: FakeNotify[];
	navigations: Array<{ targetId: string; options?: unknown }>;
	reloads: Array<{ notifies: number }>;
}

export function createFakeContext(seed: FakeContextSeed = {}): FakeContext {
	const notifies: FakeNotify[] = [];
	const navigations: FakeContext["navigations"] = [];
	const reloads: FakeContext["reloads"] = [];
	let leafId =
		seed.leafId ?? (seed.branch?.at(-1)?.id as string | undefined) ?? undefined;
	const pi = seed.pi;
	if (pi && seed.model !== undefined) pi.sessionModel = seed.model;

	const ctx = {
		ui: {
			notify: (message: string, level?: string) => {
				notifies.push({ message, level });
			},
		},
		sessionManager: {
			getSessionId: () => seed.sessionId ?? "session-test",
			getBranch: () => seed.branch ?? [],
			getLeafId: () => leafId,
		},
		isIdle: () => seed.idle ?? true,
		navigateTree: async (targetId: string, options?: unknown) => {
			navigations.push({ targetId, options });
			if (seed.navigateThrows) throw new Error(seed.navigateThrows);
			if (!seed.navigateCancelled && seed.navigateLeafId !== undefined)
				leafId = seed.navigateLeafId;
			return { cancelled: seed.navigateCancelled ?? false };
		},
		reload: async () => {
			// The ok reply must already be emitted when reload runs.
			reloads.push({ notifies: notifies.length });
			if (seed.reloadThrows !== undefined) throw new Error(seed.reloadThrows);
		},
		modelRegistry: {
			find: (provider: string | undefined, modelId: string) =>
				pi ? pi.findModel(provider, modelId) : undefined,
		},
	};
	// `ctx.model` follows the session-local model when a fake Pi is wired.
	Object.defineProperty(ctx, "model", {
		enumerable: true,
		get: () => (pi ? pi.sessionModel : seed.model),
	});

	return {
		ctx: ctx as unknown as ExtensionCommandContext,
		notifies,
		navigations,
		reloads,
	};
}

/** The most recent control reply; live state notifications are skipped. */
export function readReply(notifies: FakeNotify[]): PlexuspiReply {
	const last = notifiesWith(notifies, NOTIFY_PREFIX).at(-1);
	if (!last) throw new Error("no control reply was emitted");
	return PlexuspiReplySchema.parse(last);
}

/**
 * Set up a session with the control module wired to a policy controller. The
 * session model defaults to the first registry entry when no `model` is given.
 */
export function setupControl(
	seed: FakePiSeed & FakeContextSeed = {},
	options: PaseoControlOptions = {},
) {
	const pi = createFakePi(seed);
	const policy = new PolicyController(pi.host);
	const control = createPlexuspiControl(
		pi.api,
		{ policy, host: pi.host },
		{ sessionKey: KEY, now: () => 1234, ...options },
	);
	const fake = createFakeContext({
		...seed,
		model: seed.model ?? seed.registry?.[0],
		pi,
	});
	return { pi, policy, control, ...fake };
}

export function notifiesWith(
	notifies: FakeNotify[],
	prefix: string,
): Array<Record<string, unknown>> {
	return notifies
		.filter((notify) => notify.message.startsWith(prefix))
		.map(
			(notify) =>
				JSON.parse(notify.message.slice(prefix.length)) as Record<
					string,
					unknown
				>,
		);
}
