// src/routes/api/governance/committees/[id]/+server.ts
import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import {
  getOrgUnit, updateOrgUnit, deleteOrgUnit, deleteBoardsAfterCommit,
  listOrgUnitMembers, getChildOrgUnits, isMemberOf
} from '$lib/server/governance/org-units-db'
import {
  getOrgUnitDependents, describeOrgUnitDependents, describeCheckUnavailable, askModulesAboutOrgUnit,
  isForeignKeyViolation, OrgUnitCheckUnavailable, ORG_UNIT_STILL_REFERENCED,
  type ModuleRefCounts
} from '$lib/server/governance/org-unit-dependents'
import { getDb } from '$lib/server/db'
import { canSeeOrgUnit, seesAllGovernance } from '$lib/server/governance/visibility'
import { listRoles } from '$lib/server/governance/governance-db'
import { deprovisionOrgUnit } from '$lib/server/governance/provisioning/orchestrator'
import { writeAuditEntry } from '$lib/server/audit-db'
import { malformedIdResponse } from '$lib/server/governance/route-ids'

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
  const malformedId = malformedIdResponse(params.id)
  if (malformedId) return malformedId
  const unit = await getOrgUnit(params.id)
  if (!unit) return json({ success: false, error: 'Not found' }, { status: 404 })
  // R29-F104-KTWIN (kernel twin of F1-FIX-04 / S3#33, operator decision D-3):
  // the detail carries the unit's roster and role holders, so it follows the
  // same rule and the same 404 as the sibling members, roles and history
  // endpoints. The check runs before any roster read, and a hidden unit answers
  // like a missing one. The `children` list is unit LISTING (names only), which
  // stays as it is until the operator decides whether D-3 covers the org chart.
  const isUnitMember = seesAllGovernance(user) ? false : await isMemberOf(params.id, user.id)
  if (!canSeeOrgUnit(user, unit, isUnitMember)) {
    return json({ success: false, error: 'Not found' }, { status: 404 })
  }
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
  const malformedId = malformedIdResponse(params.id)
  if (malformedId) return malformedId
  const parsed = updateSchema.safeParse(await request.json())
  if (!parsed.success) {
    return json({ success: false, error: parsed.error.issues.map((i) => i.message).join(', ') }, { status: 400 })
  }
  const updated = await updateOrgUnit(params.id, parsed.data)
  if (!updated) return json({ success: false, error: 'Not found' }, { status: 404 })
  return json({ success: true, data: updated })
}

/** Thrown inside the delete transaction: roll it back and answer with `response`. */
class RollbackWith extends Error {
  constructor(readonly response: Response) {
    super('rollback')
  }
}

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const malformedId = malformedIdResponse(params.id)
  if (malformedId) return malformedId
  const unit = await getOrgUnit(params.id)
  if (!unit) return json({ success: false, error: 'Not found' }, { status: 404 })

  // Installed modules (board, calendar, finance) are asked first, outside the transaction:
  // their data can live in a database of their own. A module that is installed and cannot
  // answer stops the delete; "no answer" is never read as "nothing".
  let modules: ModuleRefCounts
  try {
    modules = await askModulesAboutOrgUnit(params.id)
  } catch (err) {
    if (!(err instanceof OrgUnitCheckUnavailable)) throw err
    return json({ success: false, error: describeCheckUnavailable(err.what) }, { status: 503 })
  }

  // The database comes first. One transaction locks the unit row (a record that points at
  // it has to wait), counts what hangs on it, DELETEs the row (a foreign key nobody
  // anticipated fails right here) and only then tears the external resources down, with
  // the transaction still open. A refusal, a failed teardown or a crash rolls the delete
  // back and leaves the Keycloak group, the Nextcloud folder and the Matrix room as they
  // were; nothing is answered 409 after something external is already gone.
  try {
    await getDb().begin(async (tx) => {
      const locked = await tx`SELECT id FROM org_units WHERE id = ${params.id} FOR UPDATE`
      if (locked.length === 0) throw new RollbackWith(json({ success: false, error: 'Not found' }, { status: 404 }))

      const stillThere = describeOrgUnitDependents(await getOrgUnitDependents(tx, params.id, modules))
      if (stillThere) throw new RollbackWith(json({ success: false, error: stillThere }, { status: 409 }))

      try {
        await deleteOrgUnit(tx, params.id) // CASCADE clears the unit's own rows (org-unit-dependents.ts)
      } catch (err) {
        if (!isForeignKeyViolation(err)) throw err
        throw new RollbackWith(json({ success: false, error: ORG_UNIT_STILL_REFERENCED }, { status: 409 }))
      }

      const report = await deprovisionOrgUnit(params.id)
      if (report.subsystems.some((s) => s.status === 'failed')) {
        // Keep the unit so the teardown can be retried: the rollback puts the row back.
        throw new RollbackWith(
          json({ success: false, error: 'Abbau einzelner Dienste fehlgeschlagen.', data: { report } }, { status: 207 })
        )
      }
    })
  } catch (err) {
    if (err instanceof RollbackWith) return err.response
    throw err
  }
  // The unit is gone for good. Boards kept in the board module's own database go now.
  await deleteBoardsAfterCommit(params.id)
  await writeAuditEntry({
    userId: user.id, field: 'org_unit.delete', oldValue: unit.name, newValue: params.id
  })
  return json({ success: true, data: null })
}
