/**
 * How long (ms) a session keeps an EXPIRED access token when Keycloak could not refresh it for a
 * transient reason (5xx, 429, timeout). One number for every reader of that token: the session layer
 * (auth.ts) keeps the token this long, and a server-side check of the same token (the namespaced chat
 * exchange) accepts it for as long, so the two never disagree about whether the session is still alive.
 */
export const REFRESH_GRACE_MS = 60_000
