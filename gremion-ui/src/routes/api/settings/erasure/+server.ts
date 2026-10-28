import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { writeAuditEntry } from '$lib/server/audit-db'
import { readErasureReports, startErasure } from '$lib/server/erasure/service'
import { ErasureSubjectUnknownError } from '$lib/server/erasure/subject'
import { evaluateStepUp } from '$lib/auth/step-up'
import { ERASURE_REQUIRED_LOA, erasureStepUpFreshnessSeconds } from '$lib/server/erasure/step-up'

const CONFIRM_PHRASE = 'LÖSCHEN'
// A Keycloak user id. The Nextcloud account id is the same string (user_oidc --unique-uid=0),
// so nothing else may reach an erasure; the tenant binding itself is subject.ts.
const KEYCLOAK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// TRD-196 / PRD-OPS-005: start a data-subject erasure and list the per-module
// reports. IT-admin only, plus a server-side confirmation phrase, plus (MED-4) a
// FRESH LoA 2 step-up on POST, enforced exactly like the vault reveal: a 401
// { error: 'STEP_UP_REQUIRED', requiredLoa } tells the client to run the
// /auth/step-up flow and retry. Reading reports needs no step-up. The response
// carries each module's erased | skipped | failed outcome and an overall status
// that is `complete` only when EVERY covered module was erased.
async function adminOrNull(locals: App.Locals): Promise<SessionUser | null> {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  return user && hasRole(user.roles, Role.ITAdmin) ? user : null
}

const forbidden = () => json({ success: false, error: 'Forbidden' }, { status: 403 })

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
  if (!KEYCLOAK_ID.test(subjectId)) {
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
    if (err instanceof ErasureSubjectUnknownError) {
      return json({ success: false, error: 'Person ist in diesem Mandanten unbekannt.' }, { status: 404 })
    }
    console.error('[settings/erasure] failed:', err instanceof Error ? err.message : err)
    return json({ success: false, error: 'Löschung fehlgeschlagen.' }, { status: 500 })
  }
}

export const GET: RequestHandler = async ({ url, locals }) => {
  if (!(await adminOrNull(locals))) return forbidden()
  const subjectId = url.searchParams.get('subjectId')?.trim()
  return json({ success: true, data: await readErasureReports(subjectId ? { subjectId } : {}) })
}
