import { randomUUID } from "node:crypto";
import { z } from "zod";

/**
 * Short-name event API for `plexus-pi`.
 *
 * The Plexus server may advertise an abbreviated display name per model
 * (`short_name` on `/v1/models`). The mapper carries it on each committed
 * model as the `plexusShortName` extra prop, and this publisher projects the
 * committed catalog's short names onto Pi's cross-extension event bus.
 *
 * This is a dedicated channel rather than an extension of the context-policy
 * snapshot: every schema here and there is strict on both ends, so adding a
 * field to the context-policy snapshot in a one-sided rollout would fail
 * validation and kill the whole snapshot for mismatched peers.
 */

export const SHORT_NAMES_REQUEST_CHANNEL = "plexus:short-names:request:v1";
export const SHORT_NAMES_SNAPSHOT_CHANNEL = "plexus:short-names:snapshot:v1";

export const ShortNameEntrySchema = z
	.object({
		provider: z.string().min(1),
		modelId: z.string().min(1),
		shortName: z.string().min(1).max(200),
	})
	.strict();

export const ShortNamesRequestSchema = z
	.object({
		version: z.literal(1),
		requestId: z.string().min(1).max(1024),
	})
	.strict();

export const ShortNamesSnapshotSchema = z
	.object({
		version: z.literal(1),
		publisherId: z.string().uuid(),
		revision: z.number().int().positive().safe(),
		requestId: z.string().min(1).max(1024).optional(),
		status: z.enum(["ready", "loading", "unavailable"]),
		names: z.array(ShortNameEntrySchema),
		fetchedAt: z.number().int().nonnegative().safe().optional(),
		cached: z.boolean().optional(),
		reason: z.string().max(500).optional(),
	})
	.strict()
	.superRefine((snapshot, ctx) => {
		const pairs = new Set<string>();
		for (const entry of snapshot.names) {
			const pair = `${entry.provider}\0${entry.modelId}`;
			if (pairs.has(pair))
				ctx.addIssue({
					code: "custom",
					message: "Duplicate provider/modelId short-name entry",
				});
			pairs.add(pair);
		}
		if (snapshot.status !== "ready" && snapshot.names.length !== 0) {
			ctx.addIssue({
				code: "custom",
				message: "Non-ready snapshots must have no names",
			});
		}
	});

export type ShortNameEntry = z.infer<typeof ShortNameEntrySchema>;
export type ShortNamesRequest = z.infer<typeof ShortNamesRequestSchema>;
export type ShortNamesSnapshot = z.infer<typeof ShortNamesSnapshotSchema>;

const MAX_SNAPSHOT_BYTES = 1024 * 1024;
export const SHORT_NAMES_METADATA_UNAVAILABLE_REASON =
	"Short-name metadata is not available from the committed Plexus catalog.";

export class ShortNamesPublisher {
	readonly publisherId = randomUUID();
	private revision = 1;
	private state: Omit<ShortNamesSnapshot, "requestId"> = Object.freeze({
		version: 1,
		publisherId: this.publisherId,
		revision: 1,
		status: "loading",
		names: Object.freeze([]) as unknown as ShortNameEntry[],
	});
	private readonly emit: (channel: string, data: unknown) => void;
	private readonly unsubscribe: () => void;

	constructor(events: {
		on(channel: string, handler: (data: unknown) => void): () => void;
		emit(channel: string, data: unknown): void;
	}) {
		this.emit = events.emit.bind(events);
		this.unsubscribe = events.on(SHORT_NAMES_REQUEST_CHANNEL, (data) => {
			const request = ShortNamesRequestSchema.safeParse(data);
			if (request.success) this.send(request.data.requestId);
		});
	}

	getSnapshot(): Readonly<Omit<ShortNamesSnapshot, "requestId">> {
		return this.state;
	}

	setCatalog(
		status: "ready" | "unavailable",
		names: readonly ShortNameEntry[],
		metadata?: { fetchedAt?: number; cached?: boolean; reason?: string },
	): boolean {
		const candidate = ShortNamesSnapshotSchema.safeParse({
			version: 1,
			publisherId: this.publisherId,
			revision: this.revision,
			status,
			names: [...names],
			...metadata,
		});
		const oversized =
			candidate.success &&
			new TextEncoder().encode(JSON.stringify(candidate.data)).byteLength >
				MAX_SNAPSHOT_BYTES;
		let next =
			candidate.success && !oversized
				? candidate.data
				: {
						version: 1 as const,
						publisherId: this.publisherId,
						revision: this.revision,
						status: "unavailable" as const,
						names: [] as ShortNameEntry[],
						reason: oversized
							? "Short-name snapshot exceeds the 1 MiB publication limit."
							: "Short-name snapshot could not be validated.",
					};
		if (status !== "ready" && names.length > 0) {
			next = {
				...next,
				status: "unavailable",
				names: [],
				reason: "Short-name metadata is unavailable.",
			};
		}
		const { revision: _revision, ...stateWithoutRevision } = this.state;
		const { revision: _candidateRevision, ...nextWithoutRevision } = next;
		if (
			JSON.stringify(stateWithoutRevision) ===
			JSON.stringify(nextWithoutRevision)
		)
			return false;
		this.revision++;
		this.state = Object.freeze({
			...next,
			revision: this.revision,
			names: Object.freeze(
				next.names.map((entry) => Object.freeze({ ...entry })),
			),
		});
		this.send();
		return true;
	}

	private send(requestId?: string): void {
		const snapshot = {
			...this.state,
			...(requestId === undefined ? {} : { requestId }),
		};
		let valid = ShortNamesSnapshotSchema.safeParse(snapshot);
		if (
			!valid.success ||
			new TextEncoder().encode(JSON.stringify(snapshot)).byteLength >
				MAX_SNAPSHOT_BYTES
		) {
			valid = ShortNamesSnapshotSchema.safeParse({
				version: 1,
				publisherId: this.publisherId,
				revision: this.revision,
				status: "unavailable",
				names: [],
				reason: "Short-name snapshot exceeds publication limits or is invalid.",
				...(requestId === undefined ? {} : { requestId }),
			});
		}
		if (valid.success) {
			const immutable = Object.freeze({
				...valid.data,
				names: Object.freeze(
					valid.data.names.map((entry) => Object.freeze({ ...entry })),
				),
			});
			this.emit(SHORT_NAMES_SNAPSHOT_CHANNEL, immutable);
		}
	}

	dispose(): void {
		this.unsubscribe();
	}
}
