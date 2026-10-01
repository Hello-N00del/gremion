// src/routes/api/governance/committees/[id]/members/[userId]/+server.ts
import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { removeMember } from '$lib/server/governance/provisioning/orchestrator'
import { writeAuditEntry } from '$lib/server/audit-db'

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const report = await removeMember(params.id, params.userId)
  await writeAuditEntry({
    userId: user.id, field: 'org_unit.member.remove',
    oldValue: null, newValue: `${params.id}:${params.userId}:${report.overall}`
  })
  // K2#7: a failed or degraded provisioning report is not a success (207 +
  // success:false, as the committee DELETE answers).
  if (report.overall !== 'ok') {
    return json(
      {
        success: false,
        error: 'Mitglied entfernt, aber die Bereitstellung in einzelnen Diensten ist fehlgeschlagen. Bitte die Bereitstellung des Gremiums erneut anstoßen.',
        data: { report },
      },
      { status: 207 },
    )
  }
  return json({ success: true, data: { report } })
}
