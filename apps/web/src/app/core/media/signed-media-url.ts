// Signed media URLs carry their expiry as an `e=<epoch-ms>` query param (see
// apps/api/src/lib/media-signing.ts). The web app can't re-sign — only the API
// holds the secret — but it can cheaply tell that a URL is already past its
// expiry, which is enough to avoid rendering a guaranteed-404 `<img>` from a
// stale offline snapshot.
const SIGNED_MEDIA_EXPIRY = /\/api\/media\/[^?]+\?[^#]*\be=(\d+)/;

// Treat a URL as stale slightly before its real expiry. A token at the boundary
// would otherwise pass this check yet 404 by the time the request reaches the
// origin (clock skew + network latency), so leave margin for that race.
const EXPIRY_SKEW_MS = 5 * 60_000;

/**
 * True when `url` is a signed-media URL whose `e=` expiry is in the past (or
 * within EXPIRY_SKEW_MS of it). Returns false for non-signed URLs, null/empty,
 * or comfortably-valid tokens, so it is safe to apply broadly to cached payloads.
 */
export function isSignedMediaUrlExpired(url: string | null | undefined): boolean {
  if (!url) return false;
  const match = SIGNED_MEDIA_EXPIRY.exec(url);
  if (!match) return false;
  const expiry = Number(match[1]);
  return Number.isFinite(expiry) && expiry <= Date.now() + EXPIRY_SKEW_MS;
}

/**
 * Returns `url` when it is safe to render, or null when it is an expired
 * signed-media URL that would only produce a 404. Use this at every render site
 * that may receive a signed-media URL from a restored offline snapshot or other
 * cached payload (covers, avatars, logos, attachment thumbnails, embedded
 * description images). Non-signed and comfortably-valid URLs pass through
 * unchanged. The concurrent live data fetch that follows a cache restore
 * supplies a freshly-signed URL, so a suppressed image reappears on its own.
 */
export function visibleSignedMediaUrl(url: string | null | undefined): string | null {
  return url && !isSignedMediaUrlExpired(url) ? url : null;
}
