import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { writeAuditEntry } from '$lib/server/audit-db'
import { readErasureReports, startErasure } from '$lib/server/erasure/service'

const CONFIRM_PHRASE = 'LÖSCHEN'

// TRD-196 / PRD-OPS-005: start a data-subject erasure and list the per-module
// reports. IT-admin only, like settings/reset (the comparable destructive action:
// role check plus a server-side confirmation phrase; no step-up per rows-plan.md
// S2.5). The response carries each module's erased | skipped | failed outcome and
// an overall status that is `complete` only when EVERY enabled module was erased.
async function adminOrNull(locals: App.Locals): Promise<SessionUser | null> {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  return user && hasRole(user.roles, Role.ITAdmin) ? user : null
}

const forbidden = () => json({ success: false, error: 'Forbidden' }, { status: 403 })

export const POST: RequestHandler = async ({ request, locals }) => {
  const user = await adminOrNull(locals)
  if (!user) return forbidden()

  let body: unknown = null
  try {
    body = await request.json()
  } catch {
    /* handled below as a missing confirmation */
  }
  const { confirm, subjectId: rawSubject } =
    typeof body === 'object' && body !== null ? (body as { confirm?: unknown; subjectId?: unknown }) : {}
  if (confirm !== CONFIRM_PHRASE) {
    return json({ success: false, error: `Bitte "${CONFIRM_PHRASE}" eingeben.` }, { status: 422 })
  }
  const subjectId = typeof rawSubject === 'string' ? rawSubject.trim() : ''
  if (subjectId === '' || subjectId.length > 255) {
    return json({ success: false, error: 'subjectId fehlt oder ist ungültig.' }, { status: 422 })
  }

  try {
    const report = await startErasure({ subjectId, requestedBy: user.id ?? 'unknown' })
    try {
      // The audit chain is immutable: it gets the pseudonymous ref, never the subject id.
      await writeAuditEntry({
        userId: user.id ?? 'unknown',
        field: 'erasure.run',
        oldValue: null,
        newValue: `report=${report.id} subject_ref=${report.subjectRef} status=${report.status}`,
      })
    } catch (err) {
      console.error('[settings/erasure] audit write failed:', err instanceof Error ? err.message : err)
    }
    return json({ success: true, data: report })
  } catch (err) {
    console.error('[settings/erasure] failed:', err instanceof Error ? err.message : err)
    return json({ success: false, error: 'Löschung fehlgeschlagen.' }, { status: 500 })
  }
}

export const GET: RequestHandler = async ({ url, locals }) => {
  if (!(await adminOrNull(locals))) return forbidden()
  const subjectId = url.searchParams.get('subjectId')?.trim()
  return json({ success: true, data: await readErasureReports(subjectId ? { subjectId } : {}) })
}
