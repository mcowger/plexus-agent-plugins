import {
	CHILD_NOTIFY_PREFIX,
	type ChildForward,
	SUBAGENT_BRIDGE_VERSION,
	type SubagentBridgeRecord,
} from "./protocol.ts";

/**
 * Ordered, terminal-sticky fold over owned-subagent bridge records.
 *
 * - a run must start with a `created` record before activity or terminal;
 * - per-run `sequence` must increase, so duplicate or replayed records drop;
 * - the terminal record is sticky, so a late result cannot reopen a finished child;
 * - `activeChildren` counts runs without a terminal record (the rewind guard).
 */
export interface SubagentBridgeTracker {
	/** The forward envelope for an accepted record, or undefined when dropped. */
	accept(record: SubagentBridgeRecord): ChildForward | undefined;
	/** Number of runs that have not reached a terminal record. */
	activeChildren(): number;
}

export function createSubagentBridgeTracker(
	sessionKey: string,
): SubagentBridgeTracker {
	const runs = new Map<string, { sequence: number; terminal: boolean }>();

	return {
		accept(record) {
			const existing = runs.get(record.runId);
			if (existing) {
				if (existing.terminal) return undefined;
				if (record.sequence <= existing.sequence) return undefined;
				existing.sequence = record.sequence;
				if (record.type === "terminal") existing.terminal = true;
			} else {
				if (record.type !== "created") return undefined;
				runs.set(record.runId, { sequence: record.sequence, terminal: false });
			}
			return { version: SUBAGENT_BRIDGE_VERSION, sessionKey, record };
		},
		activeChildren() {
			let count = 0;
			for (const run of runs.values()) {
				if (!run.terminal) count += 1;
			}
			return count;
		},
	};
}

/** Serialize a forward envelope as the `plexuspi:child:v1:<json>` notification payload. */
export function formatChildForward(forward: ChildForward): string {
	return `${CHILD_NOTIFY_PREFIX}${JSON.stringify(forward)}`;
}
