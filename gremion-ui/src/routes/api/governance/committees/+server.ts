import { json } from '@sveltejs/kit'
import { z } from 'zod'
import type { RequestHandler } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { listOrgUnits, createOrgUnit, deleteOrgUnit, getOrgUnit } from '$lib/server/governance/org-units-db'
import { provisionOrgUnit, deprovisionOrgUnit, wantedSubsystems } from '$lib/server/governance/provisioning/orchestrator'
import { enqueueResources } from '$lib/server/governance/provisioning/ledger'
import { getDb } from '$lib/server/db'
import { loadOrgSchema, validateCreatePlacement } from '$lib/server/governance/org-schema'
import { parseJsonBody } from '$lib/server/parse-json-body'

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).nullable().default(null),
  parentId: z.string().uuid().nullable().default(null),
  visibility: z.enum(['all_members', 'committee_only']).default('all_members')
})

export const GET: RequestHandler = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  // #196: committee id+name are non-sensitive reference data that the
  // guest-accessible calendar fetches for its filter chips. Gate on Guest,
  // matching the sibling /api/calendar/* read endpoints — not Member.
  if (!user || !hasRole(user.roles, Role.Guest)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const units = await listOrgUnits()
  return json({ success: true, data: units })
}

export const POST: RequestHandler = async ({ request, locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) {
    return json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const body = await parseJsonBody(request)
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) {
    return json(
      { success: false, error: parsed.error.issues.map((i) => i.message).join(', ') },
      { status: 400 }
    )
  }

  // P2.2 (#202): enforce the tenant org-schema placement rules — the SAME
  // validator as the seed-time blueprint check and the other create paths.
  // Closes the recon gap: a committee with parentId:null was created
  // unvalidated, but committees cannot be roots (catalog: canBeRoot=false).
  const schema = await loadOrgSchema()
  let parentKind: string | null = null
  if (parsed.data.parentId) {
    const parent = await getOrgUnit(parsed.data.parentId)
    if (!parent) {
      return json({ success: false, error: 'Übergeordnete Einheit nicht gefunden.' }, { status: 400 })
    }
    parentKind = parent.kind
  }
  const placementError = validateCreatePlacement(schema, 'committee', parentKind)
  if (placementError) {
    return json({ success: false, error: placementError }, { status: 400 })
  }

  const unit = await getDb().begin(async (tx) => {
    const u = await createOrgUnit(tx, {
      name: parsed.data.name,
      description: parsed.data.description,
      parentId: parsed.data.parentId,
      visibility: parsed.data.visibility,
      kind: 'committee',
      wantsMatrixRoom: true,
      wantsNextcloudFolder: true,
    })
    await enqueueResources(tx, u.id, wantedSubsystems(u))
    return u
  })

  const report = await provisionOrgUnit(unit.id)

  if (report.overall === 'failed') {
    const kcErr = report.subsystems.find((s) => s.subsystem === 'keycloak')?.error
    // Tear down any external resources that DID get created (e.g. Matrix room / Nextcloud folder)
    // before wiping the DB row. Best-effort: if deprovision itself fails, still clean up the row.
    try { await deprovisionOrgUnit(unit.id) } catch { /* best-effort teardown */ }
    // Guard the row deletion too (#208): if the DB cleanup throws, an unhandled
    // error would bubble up as an opaque 500 and hide the real provisioning
    // failure. Swallow it (an orphaned DB row is the lesser evil) and always
    // return the structured 502.
    try { await deleteOrgUnit(unit.id) } catch (delErr) {
      console.error('[api/governance/committees] org_unit row cleanup failed after provisioning failure:', delErr)
    }
    return json(
      { success: false, error: `Provisionierung fehlgeschlagen: ${kcErr ?? 'Keycloak'}` },
      { status: 502 }
    )
  }

  return json({ success: true, data: { unit, report } }, { status: 201 })
}
