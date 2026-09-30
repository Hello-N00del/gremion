import { getKeycloakAdminClientForCurrentTenant } from '$lib/server/keycloak-admin'

/**
 * Map the opaque public handle (username) to the real Keycloak UUID,
 * server-side only. Action endpoints receive the friendly `[handle]` from the
 * client and resolve it to the internal UUID here without ever exposing that
 * UUID across the wire. Returns null when no user has that exact username.
 *
 * F1-FIX-01 (K1#6): asks Keycloak for an EXACT username match. The previous
 * substring search capped at 5 hits returned null for a real user whose handle
 * is a prefix of 6+ other usernames.
 */
export async function resolveHandle(handle: string): Promise<string | null> {
  const kc = getKeycloakAdminClientForCurrentTenant()
  const matches = await kc.listUsers({ first: 0, max: 5, username: handle, exact: true })
  const exact = matches.find((u) => u.username === handle)
  return exact?.id ?? null
}
