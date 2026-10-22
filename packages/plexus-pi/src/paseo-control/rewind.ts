import { PROTOCOL_VERSION, type RewindEntry } from "./protocol.ts";

/** Narrow view of a Pi session entry; only what rewind validation needs. */
export interface BranchEntryLike {
	id: string;
	parentId?: string | null;
	type: string;
	message?: { role?: string };
}

export type RewindTargetResult =
	{ ok: true; entry: BranchEntryLike } | { ok: false; error: string };

/**
 * The target must be a user message on the active branch. Pi's `navigateTree`
 * moves the leaf to the selected user entry's parent, so the entry itself is
 * passed through unchanged.
 */
export function findActiveBranchUserEntry(
	branch: readonly BranchEntryLike[],
	targetEntryId: string,
): RewindTargetResult {
	const entry = branch.find((candidate) => candidate.id === targetEntryId);
	if (!entry)
		return { ok: false, error: "rewind target is not on the active branch" };
	if (entry.type !== "message" || entry.message?.role !== "user") {
		return {
			ok: false,
			error: "rewind target must be an active-branch user message",
		};
	}
	return { ok: true, entry };
}

/** Branch pin appended after a successful rewind so reopening keeps the branch. */
export function buildRewindEntry(
	targetEntryId: string,
	leafId: string | null,
	timestamp: number,
): RewindEntry {
	return {
		version: PROTOCOL_VERSION,
		targetEntryId,
		...(leafId !== null ? { leafId } : {}),
		timestamp,
	};
}

/** Pi's `navigateTree` result carries `cancelled: true` when a hook vetoed it. */
export function navigationCancelled(result: unknown): boolean {
	return Boolean(
		result &&
		typeof result === "object" &&
		(result as { cancelled?: unknown }).cancelled === true,
	);
}
