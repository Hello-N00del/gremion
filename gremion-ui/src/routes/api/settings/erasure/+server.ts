import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { writeAuditEntry } from '$lib/server/audit-db'
import { readErasureReports, startErasure } from '$lib/server/erasure/service'
import { ErasureSubjectUnknownError } from '$lib/server/erasure/subject'
import { adminOrNull, forbidden, isKeycloakId } from '$lib/server/erasure/route-guards'
import { evaluateStepUp } from '$lib/auth/step-up'
import { ERASURE_REQUIRED_LOA, erasureStepUpFreshnessSeconds } from '$lib/server/erasure/step-up'

const CONFIRM_PHRASE = 'LÖSCHEN'
// TRD-196 / PRD-OPS-005: start a data-subject erasure and list the per-module
// reports. IT-admin only, plus a server-side confirmation phrase, plus (MED-4) a
// FRESH LoA 2 step-up on POST, enforced exactly like the vault reveal: a 401
// { error: 'STEP_UP_REQUIRED', requiredLoa } tells the client to run the
// /auth/step-up flow and retry. Reading reports needs no step-up. The response
// carries each module's erased | skipped | failed outcome and an overall status
// that is `complete` only when EVERY covered module was erased.
export const POST: RequestHandler = async ({ request, locals }) => {
  const user = await adminOrNull(locals)
  if (!user) return forbidden()
  const decision = evaluateStepUp({ loa: user.loa, authTime: user.authTime }, ERASURE_REQUIRED_LOA, {
    nowMs: Date.now(),
    freshnessSeconds: erasureStepUpFreshnessSeconds(),
  })
  if (!decision.ok) {
    return json({ error: 'STEP_UP_REQUIRED', requiredLoa: decision.requiredLoa }, { status: 401 })
  }

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
  if (!isKeycloakId(subjectId)) {
    return json({ success: false, error: 'subjectId fehlt oder ist ungültig.' }, { status: 422 })
  }

  try {
    const report = await startErasure({ subjectId, requestedBy: user.id })
    try {
      // The audit chain is immutable: it gets the pseudonymous ref, never the subject id.
      await writeAuditEntry({
        userId: user.id,
        field: 'erasure.run',
        oldValue: null,
        newValue: `report=${report.id} subject_ref=${report.subjectRef} status=${report.status}`,
      })
    } catch (err) {
      console.error('[settings/erasure] audit write failed:', err instanceof Error ? err.message : err)
    }
    return json({ success: true, data: report })
  } catch (err) {
    if (err instanceof ErasureSubjectUnknownError) {
      return json({ success: false, error: 'Person ist in diesem Mandanten unbekannt.' }, { status: 404 })
    }
    console.error('[settings/erasure] failed:', err instanceof Error ? err.message : err)
    return json({ success: false, error: 'Löschung fehlgeschlagen.' }, { status: 500 })
  }
}

export const GET: RequestHandler = async ({ url, locals }) => {
  if (!(await adminOrNull(locals))) return forbidden()
  // R33f LOW: the subject id of a person being erased must not sit in a query string
  // (proxy and access logs keep it); the lookup by subject is POST .../search.
  if (url.searchParams.has('subjectId')) {
    return json({ success: false, error: 'Suche nach Person per POST /api/settings/erasure/search.' }, { status: 400 })
  }
  return json({ success: true, data: await readErasureReports({}) })
}
