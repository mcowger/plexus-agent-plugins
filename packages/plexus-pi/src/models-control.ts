import { randomUUID } from "node:crypto";
import { z } from "zod";
import { log } from "./log.ts";

/**
 * Catalog-refresh control for `plexus-pi`.
 *
 * The extension owns the Plexus catalog, so it accepts a versioned event-bus
 * command that forces a live `/v1/models` refresh and publishes the refresh
 * state. The request/reply and broadcast rules match the provider's other
 * versioned channels: Zod validation, a correlated `requestId` reply that does
 * not advance the revision, monotonic revision on change, complete immutable
 * states, and a 1 MiB publication cap.
 */

export const MODELS_REFRESH_CHANNEL = "plexus:models:refresh:v1";
export const MODELS_STATE_CHANNEL = "plexus:models:state:v1";

const MAX_STATE_BYTES = 1024 * 1024;

export const ModelsRefreshSchema = z
	.object({
		version: z.literal(1),
		requestId: z.string().min(1).max(1024),
	})
	.strict();

export const ModelsStateSchema = z
	.object({
		version: z.literal(1),
		publisherId: z.string().uuid(),
		revision: z.number().int().positive().safe(),
		requestId: z.string().min(1).max(1024).optional(),
		status: z.enum(["idle", "refreshing", "ready", "error"]),
		modelCount: z.number().int().nonnegative().safe().optional(),
		reason: z.string().max(500).optional(),
	})
	.strict();

export type ModelsRefresh = z.infer<typeof ModelsRefreshSchema>;
export type ModelsState = z.infer<typeof ModelsStateSchema>;
/** A published models state, without a correlated `requestId`. */
export type PublishedModelsState = Omit<ModelsState, "requestId">;

export interface ModelsRefreshResult {
	/** Number of Plexus models in the committed catalog after the refresh. */
	modelCount: number;
}

export interface ModelsControlHost {
	/** Force a live Plexus catalog refresh. Rejects when the refresh fails. */
	refresh(): Promise<ModelsRefreshResult>;
}

export const MODELS_REFRESH_FAILED_REASON = "The Plexus catalog refresh failed.";

const encoder = new TextEncoder();
function byteLength(value: unknown): number {
	return encoder.encode(JSON.stringify(value)).byteLength;
}

function freezeState(state: PublishedModelsState): PublishedModelsState {
	return Object.freeze({ ...state }) as PublishedModelsState;
}

function freezeParsed(state: ModelsState): ModelsState {
	return Object.freeze({ ...state }) as ModelsState;
}

function statesEqual(
	current: PublishedModelsState,
	next: { status: ModelsState["status"]; modelCount?: number; reason?: string },
): boolean {
	return (
		current.status === next.status &&
		current.modelCount === next.modelCount &&
		current.reason === next.reason
	);
}

type ModelsStatus = ModelsState["status"];

/**
 * Owns the catalog-refresh state and applies refresh commands.
 *
 * A command is handled serially with coalescing: concurrent commands share one
 * in-flight refresh and each receives a correlated reply.
 */
export class ModelsControl {
	readonly publisherId = randomUUID();
	private revision = 1;
	private state: PublishedModelsState;
	private inFlight: Promise<void> | undefined;
	private readonly emit: (channel: string, data: unknown) => void;
	private readonly unsubscribe: () => void;

	constructor(
		events: {
			on(channel: string, handler: (data: unknown) => void): () => void;
			emit(channel: string, data: unknown): void;
		},
		private readonly host: ModelsControlHost,
	) {
		this.emit = events.emit.bind(events);
		this.state = freezeState({
			version: 1,
			publisherId: this.publisherId,
			revision: 1,
			status: "idle",
		});
		this.unsubscribe = events.on(MODELS_REFRESH_CHANNEL, (data) => this.handleCommand(data));
	}

	getState(): PublishedModelsState {
		return this.state;
	}

	dispose(): void {
		this.unsubscribe();
	}

	private async handleCommand(data: unknown): Promise<void> {
		const parsed = ModelsRefreshSchema.safeParse(data);
		if (!parsed.success) return;

		if (!this.inFlight) {
			const run = this.runRefresh();
			this.inFlight = run.finally(() => {
				this.inFlight = undefined;
			});
		}
		await this.inFlight;
		this.emitState(this.state, parsed.data.requestId);
	}

	private async runRefresh(): Promise<void> {
		this.commit({ status: "refreshing" });
		try {
			const result = await this.host.refresh();
			this.commit({ status: "ready", modelCount: result.modelCount });
		} catch (error) {
			log("models:refresh failed", { error: String(error) });
			this.commit({ status: "error", reason: MODELS_REFRESH_FAILED_REASON });
		}
	}

	private commit(next: { status: ModelsStatus; modelCount?: number; reason?: string }): void {
		if (statesEqual(this.state, next)) return;
		this.revision++;
		this.state = freezeState({
			version: 1,
			publisherId: this.publisherId,
			revision: this.revision,
			status: next.status,
			...(next.modelCount === undefined ? {} : { modelCount: next.modelCount }),
			...(next.reason === undefined ? {} : { reason: next.reason }),
		});
		this.emitState(this.state);
	}

	private emitState(state: PublishedModelsState, requestId?: string): void {
		const candidate = requestId === undefined ? state : { ...state, requestId };
		const parsed = ModelsStateSchema.safeParse(candidate);
		if (parsed.success && byteLength(parsed.data) <= MAX_STATE_BYTES) {
			this.emit(MODELS_STATE_CHANNEL, freezeParsed(parsed.data));
			return;
		}
		const fallback = ModelsStateSchema.safeParse({
			version: 1,
			publisherId: this.publisherId,
			revision: this.revision,
			...(requestId === undefined ? {} : { requestId }),
			status: "error",
			reason: "Plexus catalog state is unavailable.",
		});
		if (fallback.success) this.emit(MODELS_STATE_CHANNEL, freezeParsed(fallback.data));
	}
}
