import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { getKeycloakAdminClient } from '$lib/server/keycloak-admin'
import { parseJsonBody } from '$lib/server/parse-json-body'

const updateGroupSchema = z.object({
  name: z.string().min(1).max(100).optional()
})

export const GET: RequestHandler = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const kc = getKeycloakAdminClient(locals.tenant)
  try {
    const group = await kc.getGroup(params.id)
    return json({ success: true, data: group })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg === 'Group not found') {
      return json({ success: false, error: 'Gruppe nicht gefunden' }, { status: 404 })
    }
    throw err
  }
}

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

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

  const kc = getKeycloakAdminClient(locals.tenant)
  await kc.deleteGroup(params.id)
  return json({ success: true })
}
