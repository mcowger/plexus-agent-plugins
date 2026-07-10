/**
 * Strip trailing slashes and whitespace from a URL string.
 * Returns "" for blank/invalid input.
 */
export function trimURL(s: string): string {
  return s.trim().replace(/\/+$/, "")
}

/**
 * Return the Plexus root URL for storage.
 * Idempotent — accepts either https://host or https://host/v1.
 */
export function rootURL(s: string): string {
  const next = trimURL(s)
  if (!next) return ""
  return next.endsWith("/v1") ? next.slice(0, -3) : next
}

/**
 * Return the /v1 API base for a given root URL.
 * Idempotent — if the URL already ends with /v1, returns it unchanged.
 */
export function apiBase(baseURL: string): string {
  const next = rootURL(baseURL)
  if (!next) return ""
  return `${next}/v1`
}

/**
 * Return the /v1/models URL for a given root URL.
 */
export function modelsUrl(baseURL: string): string {
  const base = apiBase(baseURL)
  return base ? `${base}/models` : ""
}
