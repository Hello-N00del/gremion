// Content Engine L3 — Instagram credentials seam (the disabled-by-default gate).
//
// Instagram publishing is shipped INERT. Activation requires BOTH the
// `content.publish.instagram` capability (granted on the route) AND resolvable
// credentials here. This module is the credentials half: today it reads a
// CONTENT-LOCAL env ref (`CONTENT_INSTAGRAM_TOKEN_REF` → resolveSecret) plus an
// ig-user id (`CONTENT_INSTAGRAM_IG_USER_ID`). Neither is set in any shipping
// environment, so `resolveInstagramCredentials()` returns null and
// `isInstagramConfigured()` is false → the drain + publish() fail closed.
//
// The richer, per-tenant control-DB outbound-integration secret slot is
// DEFERRED (Session-A owns tenant infra; L3 ships disabled regardless). The
// async signature is intentional so that future per-tenant resolution can slot
// in without touching callers.
import { env } from '$env/dynamic/private'
import { resolveSecret } from '$lib/server/tenant/secrets'

export interface InstagramCredentials {
  /** Long-lived Meta Graph access token for the IG-linked page/user. */
  accessToken: string
  /** The Instagram Business/Creator account id (Graph `/{ig-user-id}`). */
  igUserId: string
}

/**
 * Resolve the Instagram Graph credentials, or null when not configured.
 * Returns null (DISABLED) unless BOTH `CONTENT_INSTAGRAM_TOKEN_REF` (a
 * file:/env: secret ref) and `CONTENT_INSTAGRAM_IG_USER_ID` are set.
 */
export async function resolveInstagramCredentials(): Promise<InstagramCredentials | null> {
  const tokenRef = env.CONTENT_INSTAGRAM_TOKEN_REF
  const igUserId = env.CONTENT_INSTAGRAM_IG_USER_ID
  if (!tokenRef || !igUserId) return null
  // resolveSecret is fail-closed (throws on a bad/missing ref) — let that
  // surface rather than silently returning a half-configured credential.
  const accessToken = resolveSecret(tokenRef)
  return { accessToken, igUserId }
}

/** True iff Instagram publishing has resolvable credentials. False today. */
export async function isInstagramConfigured(): Promise<boolean> {
  return (await resolveInstagramCredentials()) !== null
}
