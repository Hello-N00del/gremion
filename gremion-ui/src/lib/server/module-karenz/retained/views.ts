// src/lib/server/module-karenz/retained/views.ts
// Module Karenz (phase 2, Task 19): the sealed copies as a READ-ONLY list for one module.
//
// A sealed copy outlives its Karenz row and the module database (retained_record is append-only and
// the day-30 finalize never touches it), so a module that is switched on afresh after day 30 can show
// the previous period's copies again. This file builds the list the module pages and the settings list
// route share. It only reads: there is no function here that writes, edits or deletes a copy, and
// there is no route for that either.
//
// Only canReadRetained roles get a list (Vorstand, council-admin, finance, auditor, it-admin); anyone
// else gets an empty one without the database being asked. The list carries titles, dates and counts
// from the records themselves, never record content.
import type { Role } from '$lib/auth'
import { safeFailureReason } from '$lib/server/erasure/orchestrator'
import type { TenantContext } from '$lib/server/tenant/context'
import { canReadRetained, listRetained } from './serve'

/** One row of the list: what the person sees and where the download is. */
export interface RetainedRecordView {
  id: string
  label: string
  /** ISO timestamp of the moment the copy was sealed. */
  createdAt: string
  lineCount: number
  /** The role-gated, audited, redacted download of the copy. */
  href: string
}

/** The catalogue id as the list route accepts it: a module.json id, lower case. */
const CATALOGUE_ID = /^[a-z][a-z0-9-]{0,62}$/

/** True when `id` can be a catalogue id (the route answers 400 otherwise). */
export function isCatalogueId(id: string): boolean {
  return CATALOGUE_ID.test(id)
}

/** What a copy of this module is called in the list; a module without an entry reads as the generic title. */
const LABELS: Readonly<Record<string, string>> = {
  votes: 'Umfrageergebnisse',
  elections: 'Wahlergebnisse',
}
const GENERIC_LABEL = 'Aufbewahrte Unterlagen'

export const retainedHref = (id: string): string => `/api/settings/modules/retained?id=${encodeURIComponent(id)}`

/**
 * The sealed copies of one module, newest first, for a reader who may see them. An empty list for a role
 * that may not read retained records (the database is not asked) and for a module without copies.
 */
export async function retainedViewsFor(tenant: Pick<TenantContext, 'id' | 'db'>, roles: Role[], catalogueId: string): Promise<RetainedRecordView[]> {
  if (!canReadRetained(roles)) return []
  const rows = await listRetained(tenant.id, tenant.db)
  return rows
    .filter((r) => r.catalogueId === catalogueId)
    .map((r) => ({
      id: r.id,
      label: LABELS[r.catalogueId] ?? GENERIC_LABEL,
      createdAt: r.createdAt.toISOString(),
      lineCount: r.lineCount,
      href: retainedHref(r.id),
    }))
}

/**
 * The same list for a page load: a tenant that is not wired for it (no database on the request) and a failed
 * read both give an empty list, so the module page itself never fails because of a list of old copies. A failed
 * read is logged with the tenant and the failure class, never a message (which may carry content).
 */
export async function retainedViewsForPage(tenant: Partial<Pick<TenantContext, 'id' | 'slug' | 'db'>> | undefined, roles: Role[], catalogueId: string): Promise<RetainedRecordView[]> {
  if (!tenant?.db || !tenant.id || !canReadRetained(roles)) return []
  try {
    return await retainedViewsFor({ id: tenant.id, db: tenant.db }, roles, catalogueId)
  } catch (err) {
    console.error(`[module-karenz] ${tenant.slug ?? tenant.id}: the list of retained copies for ${catalogueId} could not be read:`, safeFailureReason(err))
    return []
  }
}
