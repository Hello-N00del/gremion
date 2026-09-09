// src/routes/api/governance/committees/[id]/+server.ts
import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import {
  getOrgUnit, updateOrgUnit, deleteOrgUnit, hasMembers, hasElections, hasProtocols,
  listOrgUnitMembers, getChildOrgUnits
} from '$lib/server/governance/org-units-db'
import { listRoles } from '$lib/server/governance/governance-db'
import { deprovisionOrgUnit } from '$lib/server/governance/provisioning/orchestrator'
import { writeAuditEntry } from '$lib/server/audit-db'

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  visibility: z.enum(['all_members', 'committee_only']).optional()
})

export const GET: RequestHandler = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.Member)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const unit = await getOrgUnit(params.id)
  if (!unit) return json({ success: false, error: 'Not found' }, { status: 404 })
  const [members, roles, children] = await Promise.all([
    listOrgUnitMembers(params.id), listRoles(params.id), getChildOrgUnits(params.id)
  ])
  return json({ success: true, data: { ...unit, members, roles, children } })
}

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const parsed = updateSchema.safeParse(await request.json())
  if (!parsed.success) {
    return json({ success: false, error: parsed.error.issues.map((i) => i.message).join(', ') }, { status: 400 })
  }
  const updated = await updateOrgUnit(params.id, parsed.data)
  if (!updated) return json({ success: false, error: 'Not found' }, { status: 404 })
  return json({ success: true, data: updated })
}

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const unit = await getOrgUnit(params.id)
  if (!unit) return json({ success: false, error: 'Not found' }, { status: 404 })

  if (await hasMembers(params.id)) {
    return json({ success: false, error: 'Einheit hat noch Mitglieder und kann nicht gelöscht werden.' }, { status: 409 })
  }
  if ((await getChildOrgUnits(params.id)).length > 0) {
    return json({ success: false, error: 'Einheit hat Untergruppen und kann nicht gelöscht werden.' }, { status: 409 })
  }
  if (await hasElections(params.id)) {
    return json({ success: false, error: 'Einheit hat zugeordnete Wahlen und kann nicht gelöscht werden.' }, { status: 409 })
  }
  if (await hasProtocols(params.id)) {
    return json({ success: false, error: 'Einheit hat zugeordnete Protokolle und kann nicht gelöscht werden.' }, { status: 409 })
  }

  const report = await deprovisionOrgUnit(params.id)
  if (report.subsystems.some((s) => s.status === 'failed')) {
    // Keep the row so the teardown can be retried — no orphaned external resources lost.
    return json({ success: false, error: 'Abbau einzelner Dienste fehlgeschlagen.', data: { report } }, { status: 207 })
  }
  await deleteOrgUnit(params.id) // CASCADE clears provisioning_resources + members
  await writeAuditEntry({
    userId: user.id, field: 'org_unit.delete', oldValue: unit.name, newValue: params.id
  })
  return json({ success: true, data: null })
}
