import { error, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { z } from 'zod'
import { Role, hasRole } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { resolveVaultOrgUnitScope } from '$lib/server/vault/scope'
import { resolveVaultBackendOr503 } from '$lib/server/vault/backend/resolve'

// GET /api/vault — vault items (metadata only) the current user may see
// (org-unit scoped). Secrets are NEVER included; reveal them one at a time via
// GET /api/vault/[id]/secret.
export const GET: RequestHandler = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) throw error(403, 'Forbidden')
  const resolved = resolveVaultBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved
  const ouIds = await resolveVaultOrgUnitScope({ userId: user.id, roles: user.roles })
  const items = await backend.listItemsForOrgUnits(ouIds)
  return json({ data: items })
}

const createSchema = z.object({
  orgUnitId: z.string().min(1),
  name: z.string().min(1).max(200),
  secret: z.string().min(1).max(8192),
  username: z.string().max(200).nullable().optional(),
  url: z.string().max(2000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
})

// POST /api/vault — create a vault item. Gated to the target org-unit being in
// the current user's scope (a member cannot plant a secret in a Gremium they do
// not belong to).
export const POST: RequestHandler = async ({ request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) throw error(403, 'Forbidden')
  const resolved = resolveVaultBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved
  const parsed = createSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw error(400, parsed.error.issues.map((i) => i.message).join(', '))
  const ouIds = await resolveVaultOrgUnitScope({ userId: user.id, roles: user.roles })
  if (!ouIds.includes(parsed.data.orgUnitId)) throw error(403, 'Kein Zugriff auf diese Gliederung')
  const item = await backend.createItem({ ...parsed.data, createdBy: user.id })
  return json({ data: item }, { status: 201 })
}
