import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

const getCacheDir = (): string => join(getAgentDir(), "extensions", "plexus");
const getLogPath = (): string => join(getCacheDir(), "plexus.log");

/** Tracks whether the log directory has already been created this process,
 *  so repeated log() calls don't each re-issue a mkdir. */
let dirEnsured = false;

/**
 * Appends one line to <agentDir>/extensions/plexus/plexus.log.
 * Line format: `<ISO8601> <message> <JSON data>\n`
 * Fire-and-forget async — never blocks the caller and never throws.
 * Log ordering across rapid successive calls is not guaranteed.
 */
export function log(message: string, data?: Record<string, unknown>): void {
	void writeLogLine(message, data);
}

async function writeLogLine(message: string, data?: Record<string, unknown>): Promise<void> {
	try {
		if (!dirEnsured) {
			await mkdir(getCacheDir(), { recursive: true });
			dirEnsured = true;
		}
		const ts = new Date().toISOString();
		const line = data !== undefined
			? `${ts} ${message} ${JSON.stringify(data)}\n`
			: `${ts} ${message}\n`;
		await appendFile(getLogPath(), line, "utf8");
	} catch {
		// logging must never throw
	}
}
