import {
	getEnvSuppressedModels,
	parseSuppressionPatterns,
} from "../../plexus-models/src/index.ts";
import {
	ENV_API_KEY,
	ENV_API_URL,
	ENV_BASE_URL,
	PLEXUS_API_KEY_ENV_OPTION,
	PLEXUS_BASE_URL_OPTION,
} from "./constants.ts";
import { rootURL } from "./url.ts";

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

/** Credential resolved from the plexus integration connection (key method). */
export interface ConnectionCredential {
	key: string;
	metadata?: Record<string, unknown>;
	configuration?: Record<string, string | number | boolean | string[]>;
}

/** Plugin options from opencode.jsonc (`{ package, options }` object form). */
export type PluginOptions = Record<string, unknown>;

/** Resolve pi-style "$VAR" / "${VAR}" config templates. */
export function resolveConfigTemplate(value: string): string | undefined {
	let result = "";
	let index = 0;

	while (index < value.length) {
		const dollarIndex = value.indexOf("$", index);
		if (dollarIndex < 0) {
			result += value.slice(index);
			break;
		}

		result += value.slice(index, dollarIndex);
		const nextChar = value[dollarIndex + 1];

		if (nextChar === "$" || nextChar === "!") {
			result += nextChar;
			index = dollarIndex + 2;
			continue;
		}

		if (nextChar === "{") {
			const endIndex = value.indexOf("}", dollarIndex + 2);
			if (endIndex < 0) {
				result += "$";
				index = dollarIndex + 1;
				continue;
			}

			const name = value.slice(dollarIndex + 2, endIndex);
			if (!ENV_VAR_NAME_RE.test(name)) {
				result += value.slice(dollarIndex, endIndex + 1);
				index = endIndex + 1;
				continue;
			}

			const envValue = process.env[name];
			if (envValue === undefined) return undefined;
			result += envValue;
			index = endIndex + 1;
			continue;
		}

		const match = value.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
		if (match) {
			const envValue = process.env[match[0]];
			if (envValue === undefined) return undefined;
			result += envValue;
			index = dollarIndex + 1 + match[0].length;
			continue;
		}

		result += "$";
		index = dollarIndex + 1;
	}

	return result;
}

function resolveStringOption(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const resolved = resolveConfigTemplate(value)?.trim();
	return resolved || undefined;
}

/**
 * Resolve the API key named by an explicit `apiKeyEnv` plugin option.
 *
 * Returns undefined when the option is absent (the default `PLEXUS_API_KEY`
 * precedence still applies). When the option is present it is authoritative:
 * the named env var must exist and be non-empty, otherwise this throws instead
 * of falling back to the saved credential or `options.apiKey`. Error messages
 * name the variable but never include its value.
 */
export function resolveExplicitApiKey(
	options?: PluginOptions,
): string | undefined {
	const raw = options?.[PLEXUS_API_KEY_ENV_OPTION];
	if (raw === undefined || raw === null) return undefined;

	const name = typeof raw === "string" ? raw.trim() : "";
	if (!ENV_VAR_NAME_RE.test(name)) {
		throw new Error(
			`Invalid ${PLEXUS_API_KEY_ENV_OPTION}: expected an environment variable name`,
		);
	}

	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(
			`${PLEXUS_API_KEY_ENV_OPTION} environment variable "${name}" is missing or empty`,
		);
	}
	return value;
}

function metadataBaseURL(
	credential: ConnectionCredential | undefined,
): string | undefined {
	if (!credential) return undefined;
	const fromMetadata = resolveStringOption(
		credential.metadata?.[PLEXUS_BASE_URL_OPTION],
	);
	if (fromMetadata) return fromMetadata;
	const rawConfig = credential.configuration?.[PLEXUS_BASE_URL_OPTION];
	return typeof rawConfig === "string"
		? resolveStringOption(rawConfig)
		: undefined;
}

/**
 * Resolve { baseURL, apiKey } with priority:
 *   1. Environment variables (PLEXUS_API_URL before PLEXUS_BASE_URL; PLEXUS_API_KEY)
 *   2. Integration connection credential from /connect (key + metadata.plexusBaseURL)
 *   3. Plugin options from opencode.jsonc (plexusBaseURL, apiKey)
 *
 * An explicit `apiKeyEnv` option is authoritative and short-circuits the API
 * key chain: the named env var must be set and non-empty, otherwise this
 * throws (no fallback). When `apiKeyEnv` is omitted, the chain above applies
 * unchanged, defaulting to `PLEXUS_API_KEY`.
 *
 * baseURL candidates are normalized through rootURL(); apiKey is trimmed.
 */
export function resolveConfig(
	options?: PluginOptions,
	credential?: ConnectionCredential | undefined,
): { baseURL?: string; apiKey?: string } {
	const explicitApiKey = resolveExplicitApiKey(options);
	const envBaseURL = process.env[ENV_API_URL] ?? process.env[ENV_BASE_URL];
	const envApiKey = process.env[ENV_API_KEY];

	const metaBaseURL = credential ? metadataBaseURL(credential) : undefined;
	const optBaseURL = resolveStringOption(options?.[PLEXUS_BASE_URL_OPTION]);
	const optApiKey = resolveStringOption(options?.apiKey);

	const baseURL =
		(envBaseURL ? rootURL(envBaseURL) : undefined) ||
		(metaBaseURL ? rootURL(metaBaseURL) : undefined) ||
		(optBaseURL ? rootURL(optBaseURL) : undefined) ||
		undefined;
	const apiKey =
		explicitApiKey ||
		(envApiKey ? envApiKey.trim() : undefined) ||
		credential?.key?.trim() ||
		optApiKey ||
		undefined;

	return {
		baseURL: baseURL || undefined,
		apiKey: apiKey || undefined,
	};
}

/**
 * Merged suppression list from env (PLEXUS_SUPPRESS_MODELS / PLEXUS_EXCLUDE_MODELS)
 * plus plugin options suppressModels/suppress.
 */
export function getSuppressedModels(options?: PluginOptions): string[] {
	const envSuppressed = getEnvSuppressedModels();
	const opt =
		options?.suppressModels ?? options?.suppress ?? options?.suppress_models;
	const optSuppressed = parseSuppressionPatterns(
		opt as string | string[] | undefined,
	);
	return [...envSuppressed, ...optSuppressed];
}
