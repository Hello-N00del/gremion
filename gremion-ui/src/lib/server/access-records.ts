// src/lib/server/access-records.ts
// TRD-092 / TRD-191 / PRD-OPS-006: the council administrator's view of the
// vendor/operator access record. Admin-only and tenant-scoped: the customer slug
// is the resolved request tenant's (locals.tenant.slug), never a parameter of
// the request. The database function (oac.list_access_records) returns the rows
// of whatever slug it is passed: gremion_ui_oac is one shared credential, so the
// isolation between councils rests on this layer passing the request tenant's
// slug and nothing else.
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { AccessLogNotConfigured, getAccessDb } from './access-records-db'

export interface AccessRecord {
  id: string
  at: string
  origin: 'panel' | 'host'
  actor: string
  action: string
  what: string
  why: string
}

export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 200

/** The council administration (it-admin includes it by the role hierarchy) sees the record. */
export function mayReadAccessRecords(user: SessionUser | undefined): boolean {
  return !!user && hasRole(user.roles, Role.CouncilAdmin)
}

export function clampLimit(raw: string | null): number {
  const n = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT
  return Math.min(n, MAX_LIMIT)
}

interface Row { access_id: string; at: Date; origin: 'panel' | 'host'; actor: string; action: string; what: string; why: string }

export async function listAccessRecords(slug: string, limit: number, before: Date | null): Promise<AccessRecord[]> {
  const sql = getAccessDb()
  const rows = await sql<Row[]>`SELECT access_id, at, origin, actor, action, what, why FROM oac.list_access_records(${slug}, ${limit}, ${before})`
  return rows.map((r) => ({ id: r.access_id, at: new Date(r.at).toISOString(), origin: r.origin, actor: r.actor, action: r.action, what: r.what, why: r.why }))
}

export { AccessLogNotConfigured }

export const NOT_CONFIGURED_DE =
  'Das Zugriffsprotokoll ist auf diesem System noch nicht eingerichtet. Bitte wenden Sie sich an den Betreiber.'
