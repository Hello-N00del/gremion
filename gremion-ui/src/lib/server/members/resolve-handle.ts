import { getKeycloakAdminClientForCurrentTenant } from '$lib/server/keycloak-admin'

/**
 * Map the opaque public handle (username) to the real Keycloak UUID,
 * server-side only. Action endpoints receive the friendly `[handle]` from the
 * client and resolve it to the internal UUID here without ever exposing that
 * UUID across the wire. Returns null when no user has that exact username.
 */
export async function resolveHandle(handle: string): Promise<string | null> {
  const kc = getKeycloakAdminClientForCurrentTenant()
  const matches = await kc.listUsers({ first: 0, max: 5, search: handle })
  const exact = matches.find((u) => u.username === handle)
  return exact?.id ?? null
}
