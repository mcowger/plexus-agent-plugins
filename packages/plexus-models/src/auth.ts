const DEFAULT_API_KEY_ENV = "PLEXUS_API_KEY";
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function resolveApiKeyEnvSetting(raw: unknown): {
	name: string;
	explicit: boolean;
} {
	if (raw === undefined || raw === null)
		return { name: DEFAULT_API_KEY_ENV, explicit: false };

	const name = typeof raw === "string" ? raw.trim() : "";
	if (!ENV_VAR_NAME_RE.test(name)) {
		throw new Error("Invalid apiKeyEnv: expected an environment variable name");
	}
	return { name, explicit: true };
}

export function resolveApiKeyEnvValue(
	setting: { name: string; explicit: boolean },
	raw: string | null | undefined,
): string | undefined {
	const value = raw?.trim();
	if (!value && setting.explicit) {
		throw new Error(
			`apiKeyEnv environment variable "${setting.name}" is missing or empty`,
		);
	}
	return value || undefined;
}

export function resolvePlexusApiKey(
	setting: { name: string; explicit: boolean },
	envValue: string | null | undefined,
	storedKey: string | null | undefined,
): string | undefined {
	const envKey = resolveApiKeyEnvValue(setting, envValue);
	if (envKey !== undefined) return envKey;
	return storedKey || undefined;
}
