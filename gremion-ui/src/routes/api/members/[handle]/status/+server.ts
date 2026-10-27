import { error, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { getKeycloakAdminClient } from '$lib/server/keycloak-admin'
import { resolveHandle } from '$lib/server/members/resolve-handle'
import { parseJsonBody } from '$lib/server/parse-json-body'

const RANKED_ROLES: ReadonlySet<Role> = new Set([Role.ITAdmin, Role.CouncilAdmin, Role.Finance, Role.Member, Role.Guest])

// WI-4B admin action: enable/disable a member's account by opaque handle.
// Auth mirrors the existing /api/users/[id] endpoint exactly: read the session
// via locals.auth() and gate on Role.CouncilAdmin (which admits IT-Team via the
// role hierarchy). The handle is resolved to the internal Keycloak UUID
// server-side; the UUID never crosses the wire. Account mechanics
// (enable/disable) stay a Keycloak concern.
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) throw error(403, 'Nur Vorstand/IT')

  const body = await parseJsonBody(request)
  const enabled = (body as { enabled?: unknown } | null)?.enabled
  if (typeof enabled !== 'boolean') throw error(400, 'enabled muss boolean sein')

  const uuid = await resolveHandle(params.handle)
  if (!uuid) throw error(404, 'Mitglied nicht gefunden')

  const kc = getKeycloakAdminClient(locals.tenant)

  // Self-disable would lock the acting admin out.
  if (uuid === user.id || (user.preferredUsername && user.preferredUsername === params.handle)) {
    throw error(403, 'Das eigene Konto kann nicht geändert werden')
  }
  // Service accounts back the kernel's own Keycloak admin client.
  const target = await kc.getUser(uuid)
  if (target.username.startsWith('service-account-')) {
    throw error(403, 'Dienstkonten können nicht geändert werden')
  }
  // Role hierarchy: the caller must outrank-or-equal every ranked role the target holds.
  const targetRoles = await kc.listUserRoles(uuid)
  for (const r of targetRoles) {
    if (RANKED_ROLES.has(r.name as Role) && !hasRole(user.roles, r.name as Role)) {
      throw error(403, 'Keine Berechtigung für dieses Konto')
    }
  }

  await kc.updateUser(uuid, { enabled })
  return json({ ok: true })
}
