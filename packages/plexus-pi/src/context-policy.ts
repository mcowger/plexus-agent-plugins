import { randomUUID } from "node:crypto";
import { z } from "zod";

export const CONTEXT_POLICY_REQUEST_CHANNEL =
	"plexus:context-policy:request:v1";
export const CONTEXT_POLICY_SNAPSHOT_CHANNEL =
	"plexus:context-policy:snapshot:v1";

export const ContextPolicySchema = z
	.object({
		provider: z.string().min(1),
		modelId: z.string().min(1),
		maxContextTokens: z.number().int().positive().safe(),
		shortContextBudgetTokens: z.number().int().positive().safe(),
		pricingThresholdInputTokens: z.number().int().positive().safe().optional(),
	})
	.refine(
		(policy) => policy.shortContextBudgetTokens <= policy.maxContextTokens,
	);

export const ContextPolicyRequestSchema = z
	.object({ version: z.literal(1), requestId: z.string().min(1).max(1024) })
	.strict();

export const ContextPolicySnapshotSchema = z
	.object({
		version: z.literal(1),
		publisherId: z.string().uuid(),
		revision: z.number().int().positive().safe(),
		requestId: z.string().min(1).max(1024).optional(),
		status: z.enum(["ready", "loading", "unavailable"]),
		policies: z.array(ContextPolicySchema),
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
					message: "Duplicate provider/modelId policy",
				});
			pairs.add(pair);
		}
		if (snapshot.status !== "ready" && snapshot.policies.length !== 0) {
			ctx.addIssue({
				code: "custom",
				message: "Non-ready snapshots must have no policies",
			});
		}
	})
	.transform((snapshot) => snapshot);

export type ContextPolicy = z.infer<typeof ContextPolicySchema>;
export type ContextPolicyRequest = z.infer<typeof ContextPolicyRequestSchema>;
export type ContextPolicySnapshot = z.infer<typeof ContextPolicySnapshotSchema>;

const MAX_SNAPSHOT_BYTES = 1024 * 1024;
const SAFE_REASON =
	"Context policy limits are not available from the committed Plexus catalog metadata.";

export class ContextPolicyPublisher {
	readonly publisherId = randomUUID();
	private revision = 1;
	private state: Omit<ContextPolicySnapshot, "requestId"> = Object.freeze({
		version: 1,
		publisherId: this.publisherId,
		revision: 1,
		status: "loading",
		policies: Object.freeze([]) as unknown as ContextPolicy[],
	});
	private readonly emit: (channel: string, data: unknown) => void;
	private readonly unsubscribe: () => void;

	constructor(events: {
		on(channel: string, handler: (data: unknown) => void): () => void;
		emit(channel: string, data: unknown): void;
	}) {
		this.emit = events.emit.bind(events);
		this.unsubscribe = events.on(CONTEXT_POLICY_REQUEST_CHANNEL, (data) => {
			const request = ContextPolicyRequestSchema.safeParse(data);
			if (request.success) this.send(request.data.requestId);
		});
	}

	getSnapshot(): Readonly<Omit<ContextPolicySnapshot, "requestId">> {
		return this.state;
	}

	setCatalog(
		status: "ready" | "unavailable",
		policies: readonly ContextPolicy[],
		metadata?: { fetchedAt?: number; cached?: boolean; reason?: string },
	): boolean {
		const candidate = ContextPolicySnapshotSchema.safeParse({
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
		const reason =
			candidate.success && !oversized
				? undefined
				: "Context policy snapshot could not be validated.";
		let next =
			candidate.success && !oversized
				? candidate.data
				: {
						version: 1 as const,
						publisherId: this.publisherId,
						revision: this.revision,
						status: "unavailable" as const,
						policies: [] as ContextPolicy[],
						reason,
					};
		if (oversized)
			next = {
				...next,
				status: "unavailable",
				policies: [],
				reason: "Context policy snapshot exceeds the 1 MiB publication limit.",
			};
		if (status !== "ready" && policies.length > 0)
			next = {
				...next,
				status: "unavailable",
				policies: [],
				reason: "Context policy metadata is unavailable.",
			};
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
			policies: Object.freeze([...next.policies]) as unknown as ContextPolicy[],
		});
		this.send();
		return true;
	}

	private send(requestId?: string): void {
		const snapshot = {
			...this.state,
			...(requestId === undefined ? {} : { requestId }),
		};
		let valid = ContextPolicySnapshotSchema.safeParse(snapshot);
		if (
			!valid.success ||
			new TextEncoder().encode(JSON.stringify(snapshot)).byteLength >
				MAX_SNAPSHOT_BYTES
		) {
			valid = ContextPolicySnapshotSchema.safeParse({
				version: 1,
				publisherId: this.publisherId,
				revision: this.revision,
				status: "unavailable",
				policies: [],
				reason:
					"Context policy snapshot exceeds publication limits or is invalid.",
				...(requestId === undefined ? {} : { requestId }),
			});
		}
		if (valid.success)
			this.emit(CONTEXT_POLICY_SNAPSHOT_CHANNEL, Object.freeze(valid.data));
	}

	dispose(): void {
		this.unsubscribe();
	}
}

export const CONTEXT_POLICY_METADATA_UNAVAILABLE_REASON = SAFE_REASON;
