import * as fs from "node:fs";
import * as path from "node:path";

const PLEXUS_DIR = "extensions/plexus";
const LOG_FILE = "plexus.log";

/**
 * Appends one line to <agentDir>/extensions/plexus/plexus.log.
 *
 * Line format: `<ISO8601> <message> <JSON data>\n`
 * The data argument is omitted from the line when absent.
 *
 * Synchronous. Creates the directory if absent. Silently swallows all errors.
 */
export function log(
	agentDir: string,
	message: string,
	data?: Record<string, unknown>,
): void {
	try {
		const logPath = path.join(agentDir, PLEXUS_DIR, LOG_FILE);
		const dir = path.dirname(logPath);
		fs.mkdirSync(dir, { recursive: true });
		const ts = new Date().toISOString();
		const line = data !== undefined
			? `${ts} ${message} ${JSON.stringify(data)}\n`
			: `${ts} ${message}\n`;
		fs.appendFileSync(logPath, line, "utf8");
	} catch {
		// logging must never throw
	}
}
