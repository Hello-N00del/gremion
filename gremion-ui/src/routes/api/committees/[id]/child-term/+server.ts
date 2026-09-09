import { error, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { updateOrgUnit } from '$lib/server/governance/org-units-db'
import { Role } from '$lib/auth/types'
import { parseJsonBody } from '$lib/server/parse-json-body'

// Admin PATCH of a Gremium's child_term (the sub-header label for its children
// in the tree, e.g. "Referate" / "Arbeitsgruppen"). WI-3 Task 6.
// Gated to council-admin / it-admin — the same predicate the loader uses for
// `isAdmin`. group-helpers.ts is group-based (KV/HV), not role-based, so it
// does not fit this realm-role check.
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  const roles = locals.user?.roles ?? []
  if (!roles.includes(Role.CouncilAdmin) && !roles.includes(Role.ITAdmin)) {
    throw error(403, 'Nur Vorstand/IT')
  }
  const body = await parseJsonBody(request)
  const childTerm = (body as { childTerm?: unknown } | null)?.childTerm
  if (typeof childTerm !== 'string' || childTerm.length > 80) throw error(400, 'Ungültiger Wert')
  // '' = clear → store NULL so the unit reverts to the catalog default
  // (matches the old childTermFor truthiness, where '' never rendered, and
  // keeps the clear-field-to-reset affordance working).
  const updated = await updateOrgUnit(params.id, { childTerm: childTerm === '' ? null : childTerm })
  if (!updated) throw error(404, 'Einheit nicht gefunden')
  return json({ child_term: updated.child_term })
}
