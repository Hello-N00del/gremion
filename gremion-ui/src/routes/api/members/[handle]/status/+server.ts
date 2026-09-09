import { error, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { getKeycloakAdminClient } from '$lib/server/keycloak-admin'
import { resolveHandle } from '$lib/server/members/resolve-handle'
import { parseJsonBody } from '$lib/server/parse-json-body'

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

  await getKeycloakAdminClient(locals.tenant).updateUser(uuid, { enabled })
  return json({ ok: true })
}
