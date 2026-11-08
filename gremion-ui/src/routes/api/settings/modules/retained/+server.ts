import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import type { SessionUser } from '$lib/auth/types'
import { writeAuditEntry } from '$lib/server/audit-db'
import { safeFailureReason } from '$lib/server/erasure/orchestrator'
import { RetainedCryptoError, RetainedNotFoundError } from '$lib/server/module-karenz/retained/crypto'
import { canReadRetained, readRetainedRedacted } from '$lib/server/module-karenz/retained/serve'
import { isCatalogueId, retainedViewsFor } from '$lib/server/module-karenz/retained/views'

// Module Karenz (phase 2, Task 11): the settings download of a sealed retained copy.
//   GET /api/settings/modules/retained?id=<retained record id> -> 200 application/x-ndjson attachment
// Readable by council-admin, it-admin, finance, Vorstand and the auditor (canReadRetained). The copy is
// opened, redacted against the erasure reports (the stored bytes are never altered) and served with
// no-store. Access to retained data is accountable: an audit entry `module.retained.read` is written
// BEFORE the body is released, and when it cannot be written the answer is 503 with a short error and no record content.
// 401 no session, 403 a role that may not read, 400 no id, 404 an unknown id (the copies live in the
// request tenant's own database, so another tenant's id is unknown here), 500 a copy that does not verify.
//
//   GET /api/settings/modules/retained?module=<catalogueId> -> 200 { success: true, data: RetainedRecordView[] }
// (Task 19) The list of the sealed copies of one module, newest first, for the same roles: title, sealed date,
// line count and the download link above. It carries no record content. This route is read-only by design: it
// exports GET and nothing else, and no other route writes, edits or deletes a retained copy. 400 for a module
// that is not a catalogue id, 500 when the list cannot be read.

/** The failure class (and SQLSTATE when there is one) for the log: never a message, which may carry content. */
function failureClass(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `${safeFailureReason(err)} SQLSTATE ${code}` : safeFailureReason(err)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const GET: RequestHandler = async ({ url, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user) return json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!canReadRetained(user.roles)) return json({ success: false, error: 'Forbidden' }, { status: 403 })

  const moduleParam = url.searchParams.get('module')
  if (moduleParam !== null) {
    if (!isCatalogueId(moduleParam)) return json({ success: false, code: 'BAD_INPUT', error: 'Das Modul (module) ist ungültig.' }, { status: 400 })
    try {
      return json({ success: true, data: await retainedViewsFor(locals.tenant, user.roles, moduleParam) }, { headers: { 'Cache-Control': 'no-store' } })
    } catch (err) {
      console.error(`[settings/modules/retained] ${locals.tenant.slug}: list for ${moduleParam} failed:`, failureClass(err))
      return json({ success: false, code: 'INTERNAL', error: 'Die aufbewahrten Unterlagen konnten nicht aufgelistet werden.' }, { status: 500 })
    }
  }

  const id = url.searchParams.get('id')
  if (!id) return json({ success: false, code: 'BAD_INPUT', error: 'Es fehlt die Kennung der aufbewahrten Unterlagen (id).' }, { status: 400 })
  const notFound = () => json({ success: false, code: 'NOT_FOUND', error: 'Diese aufbewahrten Unterlagen gibt es nicht.' }, { status: 404 })
  if (!UUID.test(id)) return notFound()

  let copy: { filename: string; body: string }
  try {
    copy = await readRetainedRedacted(locals.tenant, id.toLowerCase())
  } catch (err) {
    if (err instanceof RetainedNotFoundError) return notFound()
    // the class and the id only: a crypto error never carries record content, a database error may not either
    console.error(`[settings/modules/retained] ${locals.tenant.slug}: read of ${id.toLowerCase()} failed:`, err instanceof RetainedCryptoError ? err.message : failureClass(err))
    return json({ success: false, code: 'INTERNAL', error: 'Die aufbewahrten Unterlagen konnten nicht gelesen werden.' }, { status: 500 })
  }

  try {
    await writeAuditEntry({ userId: user.id, field: 'module.retained.read', oldValue: null, newValue: id.toLowerCase() })
  } catch (err) {
    console.error(`[settings/modules/retained] ${locals.tenant.slug}: audit write for ${id.toLowerCase()} failed, nothing served:`, failureClass(err))
    return json({ success: false, code: 'AUDIT_UNAVAILABLE', error: 'Der Zugriff kann gerade nicht protokolliert werden; die Unterlagen werden deshalb nicht ausgegeben.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }

  return new Response(copy.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="${copy.filename}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
