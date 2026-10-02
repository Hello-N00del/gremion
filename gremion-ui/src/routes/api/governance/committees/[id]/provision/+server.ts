// src/routes/api/governance/committees/[id]/provision/+server.ts
import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { getOrgUnit } from '$lib/server/governance/org-units-db'
import { provisionOrgUnit } from '$lib/server/governance/provisioning/orchestrator'
import { writeAuditEntry } from '$lib/server/audit-db'

/** POST /api/governance/committees/[id]/provision — manual retry/reconcile. */
export const POST: RequestHandler = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const unit = await getOrgUnit(params.id)
  if (!unit) return json({ success: false, error: 'Not found' }, { status: 404 })

  const report = await provisionOrgUnit(params.id)
  await writeAuditEntry({
    userId: user.id, field: 'org_unit.provision',
    oldValue: null, newValue: `${params.id}:${report.overall}`
  })
  // K2#7: the retry only succeeded when the report says so (207 + success:false
  // otherwise, as the committee DELETE answers); `data` stays the report.
  if (report.overall !== 'ok') {
    return json(
      { success: false, error: 'Bereitstellung nicht vollständig: einzelne Dienste sind weiterhin fehlgeschlagen.', data: report },
      { status: 207 },
    )
  }
  return json({ success: true, data: report })
}
