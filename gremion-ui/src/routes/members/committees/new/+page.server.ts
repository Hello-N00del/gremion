// src/routes/members/committees/new/+page.server.ts
import type { PageServerLoad, Actions } from './$types'
import { hasRole, Role } from '$lib/auth'
import type { SessionUser } from '$lib/auth/types'
import { redirect, fail } from '@sveltejs/kit'
import { createOrgUnit, listOrgUnits, getOrgUnit, deleteOrgUnit } from '$lib/server/governance/org-units-db'
import { provisionOrgUnit, deprovisionOrgUnit, wantedSubsystems } from '$lib/server/governance/provisioning/orchestrator'
import { enqueueResources } from '$lib/server/governance/provisioning/ledger'
import { getDb } from '$lib/server/db'
import { loadOrgSchema, validateCreatePlacement } from '$lib/server/governance/org-schema'
import { writeAuditEntry } from '$lib/server/audit-db'

export const load: PageServerLoad = async ({ locals }) => {
  const session = await locals.auth()
  const user = session?.user as SessionUser | undefined
  if (!user || !hasRole(user.roles, Role.CouncilAdmin)) throw redirect(303, '/members')
  // The kinds are the customer's own catalogue (org_unit_kind), in its sort order. Every unit goes to the
  // form with its kind: which of them may be the parent of the chosen kind is the catalogue's
  // allowedParentKinds, the rule validateCreatePlacement applies again when the form is submitted.
  const [units, schema] = await Promise.all([listOrgUnits(), loadOrgSchema()])
  const kinds = Object.values(schema.kinds)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((k) => ({ key: k.key, label: k.label, canBeRoot: k.canBeRoot, allowedParentKinds: [...k.allowedParentKinds] }))
  // A unit may carry a display label of its own instead of its kind's label (Fachschaft, AG, ...). The
  // labels already in use are offered as suggestions; the field itself takes any text.
  const kindLabels = [...new Set(units.map((u) => u.kind_label?.trim()).filter((l): l is string => !!l))].sort((a, b) =>
    a.localeCompare(b, 'de')
  )
  return { kinds, kindLabels, parents: units.map((u) => ({ id: u.id, name: u.name, kind: u.kind })) }
}

const MAX_KIND_LABEL = 40

export const actions: Actions = {
  default: async ({ request, locals }) => {
    const session = await locals.auth()
    const user = session?.user as SessionUser | undefined
    if (!user || !hasRole(user.roles, Role.CouncilAdmin)) throw redirect(303, '/members')

    const data = await request.formData()
    const name = (data.get('name') as string | null)?.trim()
    const description = (data.get('description') as string | null)?.trim() || null
    const kind = data.get('kind') as string | null
    const kindLabelRaw = ((data.get('kindLabel') as string | null) ?? '').trim()
    const parentIdRaw = (data.get('parentId') as string | null)?.trim() || null
    const wantsMatrixRoom = data.get('wantsMatrixRoom') === 'on'
    const wantsNextcloudFolder = data.get('wantsNextcloudFolder') === 'on'

    if (!name) return fail(400, { error: 'Name ist erforderlich.' })
    // P2.2 (#202): the kind is validated against the TENANT catalog, not a
    // hardcoded council/committee/group triple.
    const schema = await loadOrgSchema()
    const kindDef = kind ? schema.kinds[kind] : undefined
    if (!kind || kindDef === undefined) {
      return fail(400, { error: 'Ungültige Art.' })
    }
    if (kindLabelRaw.length > MAX_KIND_LABEL) {
      return fail(400, { error: `Die Bezeichnung darf höchstens ${MAX_KIND_LABEL} Zeichen lang sein.` })
    }
    // The display label only stands in for the kind's label: when it says the same, nothing is stored.
    const kindLabel = kindLabelRaw === '' || kindLabelRaw === kindDef.label ? null : kindLabelRaw
    // A council must be top-level (design spec §4.2).
    const parentId = kind === 'council' ? null : parentIdRaw
    let parentKind: string | null = null
    if (parentId) {
      const parent = await getOrgUnit(parentId)
      if (!parent) return fail(400, { error: 'Übergeordnete Einheit nicht gefunden.' })
      parentKind = parent.kind
    }
    // Shared org-schema placement rule — the SAME validator as the blueprint
    // (seed-time) and the two API create paths, so the rules cannot drift.
    const placementError = validateCreatePlacement(schema, kind, parentKind)
    if (placementError) return fail(400, { error: placementError })

    const unit = await getDb().begin(async (tx) => {
      const u = await createOrgUnit(tx, {
        name, description, parentId, kind, kindLabel,
        visibility: 'all_members', wantsMatrixRoom, wantsNextcloudFolder
      })
      await enqueueResources(tx, u.id, wantedSubsystems(u))
      return u
    })
    const report = await provisionOrgUnit(unit.id)
    await writeAuditEntry({
      userId: user.id, field: 'org_unit.create',
      oldValue: null, newValue: `${unit.id}:${kind}:${report.overall}`
    })

    if (report.overall === 'failed') {
      // Keycloak — the backbone — failed. Do not redirect into a broken unit.
      const kcErr = report.subsystems.find((s) => s.subsystem === 'keycloak')?.error
      // Tear down any external resources that DID get created (e.g. Matrix room / Nextcloud folder)
      // before wiping the DB row. Best-effort: if deprovision itself fails, still clean up the row.
      try { await deprovisionOrgUnit(unit.id) } catch { /* best-effort teardown */ }
      await deleteOrgUnit(unit.id) // nothing usable was provisioned; remove the empty row
      return fail(502, { error: `Provisionierung fehlgeschlagen: ${kcErr ?? 'Keycloak'}` })
    }
    throw redirect(303, `/members/committees/${unit.id}`)
  }
}
