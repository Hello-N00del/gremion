// src/lib/server/module-karenz/retained/serve.ts
// Module Karenz (phase 2, Task 11): serving the sealed copies.
//
// Three readers of a sealed copy, one redaction rule:
//   - the settings download (routes/api/settings/modules/retained): role-gated by canReadRetained,
//     audited, served as NDJSON (readRetainedRedacted);
//   - the publication to a sink such as the files module's per-tenant folder (publishRetained), driven
//     by the engine as one retried step per (record, sink);
//   - the list of copies for the settings pages (listRetained).
//
// Art. 17 and the copies: the stored bytes are NEVER altered (the plaintext hash and the ciphertext of a
// sealed record stay as they were written). A person erased after sealing is redacted on the way out:
// every reader opens the copy, replaces the person fields of the erased subjects by 'erased' and
// serves that. The erased subjects are the subject refs of the tenant's erasure reports, whatever
// their status (a run that is still running or ended incomplete already started removing the person,
// so the copy must not show the name meanwhile). A class that keeps names under erasure (phase 3,
// finance books) is served unredacted: RetentionClassPolicy.keepsNamesUnderErasure.
//
// A published document lives outside the database, so an erasure after the publication has to
// republish it: resetPublishStepsForSubject sets the publish steps of the records naming the subject
// back to pending, and the next pass of the engine publishes the redacted version again under the
// same filename (the sink overwrites by filename).
import type { Sql } from '@gremion/db'
import { hasRole, Role } from '$lib/auth'
import { subjectRef } from '$lib/server/erasure/orchestrator'
import { getTenant, type TenantContext } from '$lib/server/tenant/context'
import { openLines, RetainedNotFoundError, toNdjson } from './crypto'
import { policyFor, type RetainedLine, type RetainedSink } from './extractors'
import { getRetainedRecord } from './store'

/** The text a person's field and id are replaced by in a redacted copy. */
export const ERASED = 'erased'

/** Who may read a retained copy: it-admin, council-admin and finance (by the role ladder), Vorstand and the auditor. */
export function canReadRetained(roles: Role[]): boolean {
  return hasRole(roles, Role.Finance) || hasRole(roles, Role.Vorstand) || hasRole(roles, Role.Auditor)
}

/**
 * The lines with the persons of erased subjects blanked: for each `persons` entry whose
 * subjectRef(tenantId, id) is in `erasedRefs`, `data[field]` and the entry's id become 'erased'.
 * Pure: the input lines (and so the stored record) are not touched. `keepsNames` returns the lines as
 * they are. `secret` defaults to AUTH_SECRET, like subjectRef.
 */
export function redactLines(lines: RetainedLine[], erasedRefs: ReadonlySet<string>, tenantId: string, keepsNames: boolean, secret?: string): RetainedLine[] {
  if (keepsNames || erasedRefs.size === 0) return lines.map((l) => structuredClone(l))
  const erasedIds = new Map<string, boolean>()
  const isErased = (personId: string): boolean => {
    let hit = erasedIds.get(personId)
    if (hit === undefined) {
      hit = erasedRefs.has(subjectRef(tenantId, personId, secret))
      erasedIds.set(personId, hit)
    }
    return hit
  }
  return lines.map((line) => {
    const out = structuredClone(line)
    out.persons = out.persons.map((p) => {
      if (!isErased(p.id)) return p
      if (Object.hasOwn(out.data, p.field)) out.data[p.field] = ERASED
      return { ...p, id: ERASED }
    })
    return out
  })
}

/** The subject refs of every erasure report of the tenant, whatever the report's status. */
async function erasedRefs(db: Sql, tenantId: string): Promise<Set<string>> {
  const rows = await db<{ subject_ref: string }[]>`SELECT DISTINCT subject_ref FROM erasure_report WHERE tenant_id = ${tenantId}`
  return new Set(rows.map((r) => r.subject_ref))
}

/** The same filename every time for one record, so a republish overwrites: characters outside [a-z0-9_-] in the catalogue id become '-'. */
export function retainedFilename(catalogueId: string, recordId: string): string {
  return `retained-${catalogueId.toLowerCase().replaceAll(/[^a-z0-9_-]/g, '-')}-${recordId.toLowerCase()}.ndjson`
}

export interface ServeDeps {
  /** The deployment secret; defaults to AUTH_SECRET. */
  secret?: string
}

/** One record opened and redacted against the CURRENT erasure reports. Throws RetainedNotFoundError / RetainedCryptoError. */
async function redactedCopy(tenant: Pick<TenantContext, 'id' | 'db'>, id: string, deps: ServeDeps): Promise<{ catalogueId: string; extractorId: string; ndjson: string }> {
  const record = await getRetainedRecord(tenant.db, id)
  if (!record) throw new RetainedNotFoundError(id)
  const lines = await openLines(tenant.db, tenant.id, id, deps)
  const redacted = redactLines(lines, await erasedRefs(tenant.db, tenant.id), tenant.id, policyFor(record.retentionClass).keepsNamesUnderErasure, deps.secret)
  return { catalogueId: record.catalogueId, extractorId: record.extractorId, ndjson: toNdjson(redacted) }
}

/** The download: the redacted NDJSON of one sealed copy and the filename it is served under. */
export async function readRetainedRedacted(tenant: Pick<TenantContext, 'id' | 'db'>, id: string, deps: ServeDeps = {}): Promise<{ filename: string; body: string }> {
  const copy = await redactedCopy(tenant, id, deps)
  return { filename: retainedFilename(copy.catalogueId, id), body: copy.ndjson }
}

/**
 * Publish one sealed copy to one sink: open, redact against the CURRENT erasure reports, send the NDJSON
 * under the stable filename. Idempotent (the sink overwrites by filename); a failure propagates so the
 * engine's publish step is recorded failed and retried.
 */
export async function publishRetained(ctx: { tenant: TenantContext; record: { id: string; catalogueId: string }; sink: RetainedSink }, deps: ServeDeps = {}): Promise<void> {
  const copy = await redactedCopy(ctx.tenant, ctx.record.id, deps)
  await ctx.sink.publish({
    tenant: ctx.tenant,
    recordId: ctx.record.id,
    title: `Aufbewahrte Unterlagen: ${ctx.record.catalogueId}`,
    filename: retainedFilename(ctx.record.catalogueId, ctx.record.id),
    ndjson: Buffer.from(copy.ndjson, 'utf8'),
  })
}

export interface RetainedListing {
  id: string
  catalogueId: string
  retentionClass: string
  lineCount: number
  createdAt: Date
}

/**
 * The sealed copies of the tenant, newest first, without ciphertext. The copies live in the tenant's own
 * database, so the list is scoped by the pool; `tenantId` must name the request tenant when no pool is passed.
 */
export async function listRetained(tenantId: string, db?: Sql): Promise<RetainedListing[]> {
  let pool = db
  if (!pool) {
    const tenant = getTenant()
    if (tenant.id !== tenantId) throw new Error('listRetained: the tenant id does not name the request tenant')
    pool = tenant.db
  }
  const rows = await pool<{ id: string; catalogue_id: string; retention_class: string; line_count: number; created_at: Date }[]>`
    SELECT id, catalogue_id, retention_class, line_count, created_at FROM retained_record
     ORDER BY created_at DESC, id`
  return rows.map((r) => ({ id: r.id, catalogueId: r.catalogue_id, retentionClass: r.retention_class, lineCount: r.line_count, createdAt: r.created_at }))
}

/** The records one Karenz row sealed, for the engine's publish steps. */
export async function listRecordsOfKarenz(db: Sql, karenzId: string): Promise<{ id: string; catalogueId: string }[]> {
  const rows = await db<{ id: string; catalogue_id: string; retention_class: string }[]>`
    SELECT id, catalogue_id, retention_class FROM retained_record
     WHERE karenz_id = ${karenzId}
     ORDER BY created_at, id`
  return rows.map((r) => ({ id: r.id, catalogueId: r.catalogue_id }))
}

/**
 * After an Art. 17 erasure: set every `publish:*` step of the retained records whose subject_refs contain
 * `ref` (a subjectRef) back to pending, so the next pass republishes them redacted. Steps of other records and
 * every other step are untouched. Returns how many steps were reset.
 */
export async function resetPublishStepsForSubject(db: Sql, ref: string): Promise<number> {
  const rows = await db<{ step: string }[]>`
    UPDATE module_karenz_step s
       SET state = 'pending', last_error = NULL, done_at = NULL, updated_at = now()
      FROM retained_record r
     WHERE s.karenz_id = r.karenz_id
       AND s.step LIKE 'publish:%'
       AND right(s.step, 37) = ':' || r.id::text
       AND ${ref}::text = ANY (r.subject_refs)
    RETURNING s.step`
  return rows.length
}
