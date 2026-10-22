import type { Conflict } from "./protocol.ts";

interface KnownControlOwner {
	readonly owner: string;
	readonly commands: readonly string[];
	readonly resolution: string;
}

/**
 * Extensions known to own tier or context request payloads. The handshake only
 * fails when one of them has declared its control command. plexus-pi is not
 * listed: it is the owner of these controls in the Plexus root.
 */
export const KNOWN_CONTROL_OWNERS: readonly KnownControlOwner[] = [
	{
		owner: "pi-microgpt",
		commands: ["fast", "flex", "long-context"],
		resolution:
			"Disable pi-microgpt's /fast, /flex, and /long-context commands for this Plexus root so plexus-pi owns tier and context selection.",
	},
];

export interface DeclaredCommand {
	name: string;
	source?: string;
}

/**
 * Detect declared control owners from the session command list. Commands with
 * no `source` are treated as extension commands.
 */
export function detectControlConflicts(
	commands: readonly DeclaredCommand[],
): Conflict[] {
	const declared = new Set(
		commands
			.filter(
				(command) =>
					command.source === undefined || command.source === "extension",
			)
			.map((command) => command.name),
	);

	const conflicts: Conflict[] = [];
	for (const known of KNOWN_CONTROL_OWNERS) {
		const matched = known.commands.filter((command) => declared.has(command));
		if (matched.length > 0) {
			conflicts.push({
				owner: known.owner,
				command: matched.join(", "),
				resolution: known.resolution,
			});
		}
	}
	return conflicts;
}
