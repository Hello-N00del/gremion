import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { listOrgUnits, createOrgUnit, deleteOrgUnit } from '$lib/server/governance/org-units-db'
import { provisionOrgUnit, deprovisionOrgUnit, wantedSubsystems } from '$lib/server/governance/provisioning/orchestrator'
import { getResources, enqueueResources } from '$lib/server/governance/provisioning/ledger'
import { getDb } from '$lib/server/db'
import { loadOrgSchema, validateCreatePlacement } from '$lib/server/governance/org-schema'

const createGroupSchema = z.object({ name: z.string().min(1).max(100) })

export const GET: RequestHandler = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const units = await listOrgUnits()
  const data = await Promise.all(units.map(async (u) => ({
    id: u.id, name: u.name, kind: u.kind,
    resources: (await getResources(u.id)).map((r) => ({ subsystem: r.subsystem, status: r.status }))
  })))
  return json({ success: true, data })
}

export const POST: RequestHandler = async ({ request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const parsed = createGroupSchema.safeParse(await request.json())
  if (!parsed.success) {
    return json({ success: false, error: parsed.error.issues.map((i) => i.message).join(', ') }, { status: 400 })
  }
  // P2.2 (#202): a standalone group is a top-level kind='group' org-unit —
  // allowed only if the tenant catalog says groups can be roots (StuRa: yes).
  // Shared validator with the other two create paths so the rules can't drift.
  const schema = await loadOrgSchema()
  const placementError = validateCreatePlacement(schema, 'group', null)
  if (placementError) {
    return json({ success: false, error: placementError }, { status: 400 })
  }
  const unit = await getDb().begin(async (tx) => {
    const u = await createOrgUnit(tx, {
      name: parsed.data.name, description: null, parentId: null, kind: 'group',
      visibility: 'committee_only', wantsMatrixRoom: true, wantsNextcloudFolder: true
    })
    await enqueueResources(tx, u.id, wantedSubsystems(u))
    return u
  })
  const report = await provisionOrgUnit(unit.id)

  if (report.overall === 'failed') {
    const kcErr = report.subsystems.find((s) => s.subsystem === 'keycloak')?.error
    // Mirror api/governance/committees: tear down any external resources that DID
    // get created, wipe the DB row, and surface the failure (#185) instead of
    // returning 201 with an orphaned, half-provisioned org_unit.
    try { await deprovisionOrgUnit(unit.id) } catch { /* best-effort teardown */ }
    // Guard the row deletion too (#208): if the DB cleanup throws, an unhandled
    // error would bubble up as an opaque 500 and hide the real provisioning
    // failure. Swallow it (an orphaned DB row is the lesser evil) and always
    // return the structured 502.
    try { await deleteOrgUnit(unit.id) } catch (delErr) {
      console.error('[api/groups] org_unit row cleanup failed after provisioning failure:', delErr)
    }
    return json(
      { success: false, error: `Provisionierung fehlgeschlagen: ${kcErr ?? 'Keycloak'}` },
      { status: 502 }
    )
  }

  return json({ success: true, data: { id: unit.id, report } }, { status: 201 })
}
