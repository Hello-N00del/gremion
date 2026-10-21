import { error, json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { Role, hasRole } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { resolveVaultOrgUnitScope } from '$lib/server/vault/scope'
import { resolveVaultBackendOr503 } from '$lib/server/vault/backend/resolve'

// Pagination bounds — mirror the leaf's clamps so kernel and leaf agree.
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/** Parse a non-negative integer query param, falling back when absent/invalid. */
function intParam(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : fallback
}

// GET /api/vault/access-log — the reveal-audit trail (Zugriffsprotokoll, #405
// design v11), org-unit scoped: a member sees the reveals in THEIR org-units,
// an it-admin sees all units (resolveVaultOrgUnitScope). Rows come back newest
// first, joined with the item name, limit/offset paginated. Note: SvelteKit
// routes the static `access-log` segment BEFORE the [id] param route, so this
// never shadows GET /api/vault/[id].
export const GET: RequestHandler = async ({ url, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) throw error(403, 'Forbidden')
  const resolved = resolveVaultBackendOr503()
  if (resolved instanceof Response) return resolved
  const backend = resolved
  const ouIds = await resolveVaultOrgUnitScope({ userId: user.id, roles: user.roles })
  const limit = Math.min(Math.max(intParam(url.searchParams.get('limit'), DEFAULT_LIMIT), 1), MAX_LIMIT)
  const offset = intParam(url.searchParams.get('offset'), 0)
  const entries = await backend.listAccessLog(ouIds, { limit, offset })
  return json({ data: entries, limit, offset })
}
