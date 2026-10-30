import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { getKeycloakAdminClient, KcAdminError } from '$lib/server/keycloak-admin'
import { parseJsonBody } from '$lib/server/parse-json-body'
import { isUuid } from '../../../../params/uuid'

const updateGroupSchema = z.object({
  name: z.string().min(1).max(100).optional()
})

// F1-FIX-01 (H03): the id is spliced into a Keycloak realm-admin path. Only a
// UUID may pass; anything path-shaped (`../clients/x`, `..%2Fclients`) is a 404
// and no admin call is made. Checked AFTER the role gate so the 404 is not an
// oracle for unauthenticated callers.
const notFound = () => json({ success: false, error: 'Gruppe nicht gefunden' }, { status: 404 })

export const GET: RequestHandler = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  if (!isUuid(params.id)) return notFound()

  const kc = getKeycloakAdminClient(locals.tenant)
  try {
    const group = await kc.getGroup(params.id)
    return json({ success: true, data: group })
  } catch (err) {
    if (err instanceof KcAdminError && err.status === 404) return notFound()
    throw err
  }
}

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  if (!isUuid(params.id)) return notFound()

  const body = await parseJsonBody(request)
  const parsed = updateGroupSchema.safeParse(body)
  if (!parsed.success) {
    return json(
      { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') },
      { status: 400 }
    )
  }

  const kc = getKeycloakAdminClient(locals.tenant)
  await kc.updateGroup(params.id, parsed.data)
  return json({ success: true })
}

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.ITAdmin)) {
    return json({ success: false, error: 'Forbidden: deleting groups requires it-admin role' }, { status: 403 })
  }
  if (!isUuid(params.id)) return notFound()

  const kc = getKeycloakAdminClient(locals.tenant)
  await kc.deleteGroup(params.id)
  return json({ success: true })
}
