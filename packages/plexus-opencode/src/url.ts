/**
 * Strip trailing slashes and whitespace from a URL string.
 * Returns "" for blank/invalid input.
 */
export function trimURL(s: string): string {
  return s.trim().replace(/\/+$/, "")
}

/**
 * Return the /v1 API base for a given root URL.
 * Idempotent — if the URL already ends with /v1, returns it unchanged.
 */
export function apiBase(baseURL: string): string {
  const next = trimURL(baseURL)
  if (!next) return ""
  return next.endsWith("/v1") ? next : `${next}/v1`
}

/**
 * Return the /v1/models URL for a given root URL.
 */
export function modelsUrl(baseURL: string): string {
  const base = apiBase(baseURL)
  return base ? `${base}/models` : ""
}
