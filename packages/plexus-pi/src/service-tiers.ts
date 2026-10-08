import { randomUUID } from "node:crypto";
import { z } from "zod";

export const SERVICE_TIERS_REQUEST_CHANNEL = "plexus:service-tiers:request:v1";
export const SERVICE_TIERS_SNAPSHOT_CHANNEL =
	"plexus:service-tiers:snapshot:v1";

export const ServiceTierPolicySchema = z
	.object({
		provider: z.string().min(1),
		modelId: z.string().min(1),
		serviceTiers: z.array(z.string().min(1).max(100)).min(1).max(64),
	})
	.strict()
	.refine(
		(policy) =>
			new Set(policy.serviceTiers).size === policy.serviceTiers.length,
	);

export const ServiceTiersRequestSchema = z
	.object({
		version: z.literal(1),
		requestId: z.string().min(1).max(1024),
	})
	.strict();

export const ServiceTiersSnapshotSchema = z
	.object({
		version: z.literal(1),
		publisherId: z.string().uuid(),
		revision: z.number().int().positive().safe(),
		requestId: z.string().min(1).max(1024).optional(),
		status: z.enum(["ready", "loading", "unavailable"]),
		policies: z.array(ServiceTierPolicySchema),
		fetchedAt: z.number().int().nonnegative().safe().optional(),
		cached: z.boolean().optional(),
		reason: z.string().max(500).optional(),
	})
	.strict()
	.superRefine((snapshot, ctx) => {
		const pairs = new Set<string>();
		for (const policy of snapshot.policies) {
			const pair = `${policy.provider}\0${policy.modelId}`;
			if (pairs.has(pair))
				ctx.addIssue({
					code: "custom",
					message: "Duplicate provider/modelId service-tier policy",
				});
			pairs.add(pair);
		}
		if (snapshot.status !== "ready" && snapshot.policies.length !== 0) {
			ctx.addIssue({
				code: "custom",
				message: "Non-ready snapshots must have no policies",
			});
		}
	});

export type ServiceTierPolicy = z.infer<typeof ServiceTierPolicySchema>;
export type ServiceTiersSnapshot = z.infer<typeof ServiceTiersSnapshotSchema>;

const MAX_SNAPSHOT_BYTES = 1024 * 1024;
export const SERVICE_TIERS_METADATA_UNAVAILABLE_REASON =
	"Service-tier metadata is not available from the committed Plexus catalog.";

export class ServiceTiersPublisher {
	readonly publisherId = randomUUID();
	private revision = 1;
	private state: Omit<ServiceTiersSnapshot, "requestId"> = Object.freeze({
		version: 1,
		publisherId: this.publisherId,
		revision: 1,
		status: "loading",
		policies: Object.freeze([]) as unknown as ServiceTierPolicy[],
	});
	private readonly emit: (channel: string, data: unknown) => void;
	private readonly unsubscribe: () => void;

	constructor(events: {
		on(channel: string, handler: (data: unknown) => void): () => void;
		emit(channel: string, data: unknown): void;
	}) {
		this.emit = events.emit.bind(events);
		this.unsubscribe = events.on(SERVICE_TIERS_REQUEST_CHANNEL, (data) => {
			const request = ServiceTiersRequestSchema.safeParse(data);
			if (request.success) this.send(request.data.requestId);
		});
	}

	getSnapshot(): Readonly<Omit<ServiceTiersSnapshot, "requestId">> {
		return this.state;
	}

	setCatalog(
		status: "ready" | "unavailable",
		policies: readonly ServiceTierPolicy[],
		metadata?: { fetchedAt?: number; cached?: boolean; reason?: string },
	): boolean {
		const candidate = ServiceTiersSnapshotSchema.safeParse({
			version: 1,
			publisherId: this.publisherId,
			revision: this.revision,
			status,
			policies: [...policies],
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
						policies: [] as ServiceTierPolicy[],
						reason: oversized
							? "Service-tier snapshot exceeds the 1 MiB publication limit."
							: "Service-tier snapshot could not be validated.",
					};
		if (status !== "ready" && policies.length > 0) {
			next = {
				...next,
				status: "unavailable",
				policies: [],
				reason: "Service-tier metadata is unavailable.",
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
			policies: Object.freeze(
				next.policies.map((policy) =>
					Object.freeze({
						...policy,
						serviceTiers: Object.freeze([...policy.serviceTiers]),
					}),
				),
			) as unknown as ServiceTierPolicy[],
		});
		this.send();
		return true;
	}

	private send(requestId?: string): void {
		const snapshot = {
			...this.state,
			...(requestId === undefined ? {} : { requestId }),
		};
		let valid = ServiceTiersSnapshotSchema.safeParse(snapshot);
		if (
			!valid.success ||
			new TextEncoder().encode(JSON.stringify(snapshot)).byteLength >
				MAX_SNAPSHOT_BYTES
		) {
			valid = ServiceTiersSnapshotSchema.safeParse({
				version: 1,
				publisherId: this.publisherId,
				revision: this.revision,
				status: "unavailable",
				policies: [],
				reason:
					"Service-tier snapshot exceeds publication limits or is invalid.",
				...(requestId === undefined ? {} : { requestId }),
			});
		}
		if (valid.success) {
			const immutable = Object.freeze({
				...valid.data,
				policies: Object.freeze(
					valid.data.policies.map((policy) =>
						Object.freeze({
							...policy,
							serviceTiers: Object.freeze([...policy.serviceTiers]),
						}),
					),
				),
			});
			this.emit(SERVICE_TIERS_SNAPSHOT_CHANNEL, immutable);
		}
	}

	dispose(): void {
		this.unsubscribe();
	}
}
