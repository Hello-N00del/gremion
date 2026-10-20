import { error, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { z } from 'zod'
import { Role, hasRole } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { resolveVaultOrgUnitScope } from '$lib/server/vault/scope'
import { assertVaultItemId } from '$lib/server/vault/item-id'
import { resolveVaultBackendOr503 } from '$lib/server/vault/backend/resolve'
import type { VaultBackendPort, VaultItem } from '$lib/server/vault/backend'

// Shared gate: authenticated member + the item exists + its org-unit is in the
// user's scope. Returns the resolved item so callers do not re-fetch it.
async function gate(
  locals: App.Locals,
  id: string,
  backend: VaultBackendPort,
): Promise<{ user: SessionUser; item: VaultItem }> {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) throw error(403, 'Forbidden')
  // #449: reject a malformed id before it reaches the leaf's UUID column.
  assertVaultItemId(id)
  const item = await backend.getItem(id)
  if (!item) throw error(404, 'Eintrag nicht gefunden')
  const ouIds = await resolveVaultOrgUnitScope({ userId: user.id, roles: user.roles })
  if (!ouIds.includes(item.org_unit_id)) throw error(403, 'Kein Zugriff auf diesen Eintrag')
  return { user, item }
}

// GET /api/vault/[id] — one item's metadata (NO secret), org-unit scoped.
export const GET: RequestHandler = async ({ params, locals }) => {
  const resolved = resolveVaultBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved
  const { item } = await gate(locals, params.id, backend)
  return json({ data: item })
}

// Mirrors the create schema (/api/vault POST) with every field optional: absent
// = keep, null = clear (nullable fields only). A provided field is validated
// with the same bounds as on create.
const updateSchema = z.object({
  orgUnitId: z.string().min(1).optional(),
  name: z.string().min(1).max(200).optional(),
  secret: z.string().min(1).max(8192).optional(),
  username: z.string().max(200).nullable().optional(),
  url: z.string().max(2000).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
})

// PUT /api/vault/[id] — update a vault item (#405 design v11: closes the former
// "no edit route" runbook residual). Scope-gated on the item's CURRENT org-unit
// via gate(); when the patch MOVES the item (orgUnitId), the TARGET org-unit
// must also be in the caller's scope — a member cannot push a secret into a
// Gremium they do not belong to (mirrors the create gate).
export const PUT: RequestHandler = async ({ params, request, locals }) => {
  const resolved = resolveVaultBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved
  const { user, item } = await gate(locals, params.id, backend)
  const parsed = updateSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw error(400, parsed.error.issues.map((i) => i.message).join(', '))
  if (parsed.data.orgUnitId !== undefined && parsed.data.orgUnitId !== item.org_unit_id) {
    const ouIds = await resolveVaultOrgUnitScope({ userId: user.id, roles: user.roles })
    if (!ouIds.includes(parsed.data.orgUnitId)) throw error(403, 'Kein Zugriff auf diese Gliederung')
  }
  const updated = await backend.updateItem(params.id, parsed.data)
  if (!updated) throw error(404, 'Eintrag nicht gefunden')
  return json({ data: updated })
}

// DELETE /api/vault/[id] — remove a vault item, org-unit scoped.
export const DELETE: RequestHandler = async ({ params, locals }) => {
  const resolved = resolveVaultBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved
  await gate(locals, params.id, backend)
  await backend.deleteItem(params.id)
  return new Response(null, { status: 204 })
}
