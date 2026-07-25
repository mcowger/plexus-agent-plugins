/**
 * Model suppression/exclusion utilities for Plexus.
 *
 * Allows suppressing models by exact name/id, glob wildcard pattern (e.g. "gpt-3.5*", "*deprecated*"),
 * or regex (e.g. "regex:^gpt-[34]").
 */

/**
 * Parses raw suppression pattern input into an array of trimmed, non-empty pattern strings.
 * Input can be a string (comma-, semicolon-, or newline-separated) or an array of strings.
 */
export function parseSuppressionPatterns(raw: string | string[] | undefined | null): string[] {
	if (!raw) return [];
	const items = Array.isArray(raw) ? raw : raw.split(/[\n,;]+/);
	return items.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Reads suppression patterns from environment variables:
 * - PLEXUS_SUPPRESS_MODELS
 * - PLEXUS_EXCLUDE_MODELS
 */
export function getEnvSuppressedModels(): string[] {
	const env = typeof process !== "undefined" && process?.env ? process.env : {};
	const raw = env.PLEXUS_SUPPRESS_MODELS ?? env.PLEXUS_EXCLUDE_MODELS;
	return parseSuppressionPatterns(raw);
}

/**
 * Checks if a model (given its id and optional display name) matches any suppression pattern.
 *
 * Matching behavior:
 * - Case-insensitive.
 * - Exact match against full `id`, `name`, or short ID (suffix after `/` or `:`).
 * - Glob wildcards (`*` matches any sequence of characters, `?` matches a single character).
 * - Advanced regex matching if the pattern is prefixed with `regex:`.
 */
export function isModelSuppressed(
	model: { id: string; name?: string },
	patterns?: string | string[] | null,
): boolean {
	const envPatterns = getEnvSuppressedModels();
	const explicitPatterns = parseSuppressionPatterns(patterns);
	const allPatterns = [...envPatterns, ...explicitPatterns];

	if (allPatterns.length === 0) return false;

	const id = model.id.toLowerCase();
	const name = (model.name ?? "").toLowerCase();
	const shortId = id.includes("/")
		? id.split("/").pop()!
		: id.includes(":")
			? id.split(":").pop()!
			: id;

	for (const pattern of allPatterns) {
		if (matchesPattern(id, name, shortId, pattern)) {
			return true;
		}
	}

	return false;
}

function matchesPattern(id: string, name: string, shortId: string, pattern: string): boolean {
	const p = pattern.toLowerCase();
	if (p.startsWith("regex:")) {
		try {
			const re = new RegExp(pattern.slice(6), "i");
			return re.test(id) || re.test(name) || re.test(shortId);
		} catch {
			return false;
		}
	}

	if (p.includes("*") || p.includes("?")) {
		const regexStr =
			"^" +
			p
				.replace(/([.+^${}()|[\]\\])/g, "\\$1")
				.replace(/\*/g, ".*")
				.replace(/\?/g, ".") +
			"$";
		try {
			const re = new RegExp(regexStr, "i");
			return re.test(id) || re.test(name) || re.test(shortId);
		} catch {
			return false;
		}
	}

	return id === p || name === p || shortId === p;
}
