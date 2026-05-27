import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const getCacheDir = (): string => join(getAgentDir(), "extensions", "plexus");
const getLogPath = (): string => join(getCacheDir(), "plexus.log");

/**
 * Appends one line to <agentDir>/extensions/plexus/plexus.log.
 * Line format: `<ISO8601> <message> <JSON data>\n`
 * Synchronous. Creates the directory if absent. Silently swallows all errors.
 */
export function log(message: string, data?: Record<string, unknown>): void {
	try {
		mkdirSync(getCacheDir(), { recursive: true });
		const ts = new Date().toISOString();
		const line = data !== undefined
			? `${ts} ${message} ${JSON.stringify(data)}\n`
			: `${ts} ${message}\n`;
		appendFileSync(getLogPath(), line, "utf8");
	} catch {
		// logging must never throw
	}
}
