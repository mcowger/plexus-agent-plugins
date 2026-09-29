import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getDir } from "./cache.ts";

export interface Logger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

/**
 * Logs to the console and appends to <data>/opencode/plugins/plexus/plugin.log.
 * The V2 service runs with stdout on /dev/null, so the file is the only
 * reliable sink. Logging never throws.
 */
export function createLogger(prefix = "plexus"): Logger {
	function log(level: "info" | "warn" | "error", message: string): void {
		const line = `[${prefix}] ${message}`;
		try {
			if (level === "error") console.error(line);
			else if (level === "warn") console.warn(line);
			else console.log(line);
		} catch {
			// ignore
		}
		try {
			const dir = getDir();
			mkdirSync(dir, { recursive: true });
			appendFileSync(join(dir, "plugin.log"), `${new Date().toISOString()} ${level.toUpperCase()} ${message}\n`);
		} catch {
			// ignore
		}
	}

	return {
		info: (message) => log("info", message),
		warn: (message) => log("warn", message),
		error: (message) => log("error", message),
	};
}
