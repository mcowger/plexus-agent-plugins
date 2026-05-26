/**
 * Wire types for the Plexus /v1/models API response.
 * Modeled after the OpenRouter API schema.
 */

export interface PlexusModelArchitecture {
	modality?: string;
	input_modalities?: string[];
	output_modalities?: string[];
	tokenizer?: string;
	instruct_type?: string | null;
}

export interface PlexusModelPricing {
	/** Cost per input token (decimal string). */
	prompt?: string;
	/** Cost per output token (decimal string). */
	completion?: string;
	/** Cost per cached-read token (decimal string). */
	input_cache_read?: string;
	/** Cost per cache-write token (decimal string). */
	input_cache_write?: string;
}

export interface PlexusTopProvider {
	context_length?: number | null;
	max_completion_tokens?: number | null;
	is_moderated?: boolean;
}

/** Per-model object returned by the Plexus /v1/models endpoint. */
export interface PlexusApiModel {
	/** Required. Models without this are silently dropped during batch conversion. */
	id: string;
	object?: string;
	created?: number;
	owned_by?: string;
	/** API dialect hint(s). May be a single string or an array; first recognized entry wins. */
	preferred_api?: string | string[];
	/** Human-readable display name. Falls back to id when absent. */
	name?: string;
	description?: string;
	context_length?: number | null;
	architecture?: PlexusModelArchitecture;
	pricing?: PlexusModelPricing;
	/** Used to infer reasoning capability. */
	supported_parameters?: string[];
	top_provider?: PlexusTopProvider;
	/** Optional hint to look up the canonical entry in the host agent's built-in registry. */
	pi_provider?: string;
	/** Optional hint to look up the canonical entry in the host agent's built-in registry. */
	pi_model?: string;
	/**
	 * Optional host-specific compat overrides supplied directly by the Plexus server.
	 * When present, these values should be merged into (and take precedence over) any
	 * heuristically-detected compat flags in the host transformer. This allows the
	 * Plexus operator to precisely specify wire-protocol behavior per model without
	 * requiring a new transformer release.
	 *
	 * Example: { "thinkingFormat": "deepseek", "requiresReasoningContentOnAssistantMessages": true }
	 */
	pi_options?: Record<string, unknown>;
}

/** Top-level envelope returned by GET /v1/models. */
export interface PlexusApiResponse {
	object: string;
	data: PlexusApiModel[];
}

/**
 * Canonical host-neutral model descriptor produced by the conversion pipeline.
 * This is what cache files store and what host packages consume.
 *
 * The `compat` and `thinkingLevelMap` fields are reserved for host packages;
 * this package never populates them.
 */
export interface PlexusModelDescriptor {
	id: string;
	name: string;
	/** One of the four canonical API dialect strings. */
	preferredApi: string;
	/** Always the literal string "plexus". */
	provider: "plexus";
	/** Base URL adjusted for the API dialect. */
	baseUrl: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: {
		/** $/million tokens (parsed float, 0 when absent or invalid). */
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
	/**
	 * Host-specific compatibility overrides.
	 * Never populated by this package — reserved for the host adapter.
	 */
	compat?: Record<string, unknown>;
	/**
	 * Maps host thinking levels to provider-specific values.
	 * Never populated by this package — reserved for the host adapter.
	 */
	thinkingLevelMap?: Record<string, string>;
	/** Present only when pi_provider was set on the API model. */
	piProvider?: string;
	/** Present only when pi_model was set on the API model. */
	piModel?: string;
	/**
	 * Host-specific compat overrides supplied by the Plexus server via pi_options.
	 * When present, the host transformer MUST merge these into (and let them win over)
	 * any heuristically-detected compat flags.
	 */
	piOptions?: Record<string, unknown>;
}

/** Shape of the on-disk model cache file. */
export interface ModelCache {
	models: PlexusModelDescriptor[];
	/** Unix millisecond epoch set at write time. */
	timestamp: number;
}
