import { getKeycloakAdminClientForCurrentTenant, type KeycloakAdminClient } from '../keycloak-admin'
import type { GremionConfig } from '../config'
import type { GremionBlueprint } from './org-blueprint'
import { validateBlueprint } from './org-blueprint'
import { seedMunicipalDemo } from './seed-municipal-demo'
import { env } from '$env/dynamic/private'
import { getDb } from '../db'
import { createOrgUnit, addOrgUnitMember } from '../governance/org-units-db'
import { GREMION_ORG_SCHEMA, orgSchemaFromBlueprint } from '../governance/org-schema'
import { createRole, createAssignment } from '../governance/governance-db'
import { provisionOrgUnit, addMember, defaultAdapters } from '../governance/provisioning/orchestrator'
import type { Adapters, ProvisioningReport } from '../governance/provisioning/types'

/** Grace-period days for seeded roles — mirrors the governance roles API default. */
const SEED_GRACE_PERIOD_DAYS = 14

export interface SeedReport {
  users: number
  orgUnits: number
  memberships: number
  roles: number
  assignments: number
  provisioning: Array<{ orgUnitKey: string; overall: 'ok' | 'degraded' | 'failed' }>
  /** P2.2 (#202): caucus rows seeded from the blueprint's caucuses section (0 for StuRa). */
  caucuses: number
  /** P0 demo-fixture counts — present only when `includeDemo` is true. In the
   *  governance-only kernel the demo seed is the municipal showcase (a published
   *  Beschluss/protocol); feature-module fixtures (calendar/elections/news/…)
   *  are carved out, so only the governance-relevant counts remain. */
  demo?: {
    calendarEvents: number
    protocols: number
  }
  errors: string[]
}

/** Create every blueprint user in Keycloak (idempotent on "already exists") and
 *  assign its realm role. Returns a username -> Keycloak-user-id map. */
export async function seedUsers(
  bp: GremionBlueprint,
  kc: Pick<KeycloakAdminClient, 'createUser' | 'listUsers' | 'listRealmRoles' | 'assignRoles'>,
  password: string
): Promise<Map<string, string>> {
  const realmRoles = await kc.listRealmRoles()
  const map = new Map<string, string>()
  for (const u of bp.users) {
    let id: string
    try {
      id = await kc.createUser({
        username: u.username, email: u.email,
        firstName: u.firstName, lastName: u.lastName,
        enabled: true, emailVerified: true,
        credentials: [{ type: 'password', value: password, temporary: false }]
      })
    } catch (err) {
      const found = (await kc.listUsers({ search: u.username })).find((x) => x.username === u.username)
      if (!found) {
        const original = err instanceof Error ? err.message : String(err)
        throw new Error(`seedUsers: could not create or find user ${u.username} (createUser failed: ${original})`)
      }
      id = found.id
    }
    const role = realmRoles.find((r) => r.name === u.realmRole)
    if (!role) throw new Error(`seedUsers: realm role ${u.realmRole} not found`)
    await kc.assignRoles(id, [role])
    map.set(u.username, id)
  }
  return map
}

/** P2.2 (#202): upsert the blueprint's per-tenant kind catalog into
 *  `org_unit_kind`. Must run BEFORE seedOrgUnits — the org_units.kind FK
 *  (migration 038) needs the catalog rows. No-op when the blueprint carries
 *  no orgSchema section (StuRa relies on the 038 defaults). */
export async function seedOrgSchema(bp: Pick<GremionBlueprint, 'orgSchema'>): Promise<void> {
  if (!bp.orgSchema) return
  const sql = getDb()
  for (const [i, k] of bp.orgSchema.entries()) {
    await sql`
      INSERT INTO org_unit_kind
        (key, label, child_term, allowed_parent_kinds, can_be_root, root_min, root_max, sort_order)
      VALUES
        (${k.key}, ${k.label}, ${k.childTerm ?? null}, ${k.allowedParentKinds},
         ${k.canBeRoot}, ${k.rootMin ?? 0}, ${k.rootMax ?? null}, ${k.sortOrder ?? i})
      ON CONFLICT (key) DO UPDATE SET
        label = EXCLUDED.label,
        child_term = EXCLUDED.child_term,
        allowed_parent_kinds = EXCLUDED.allowed_parent_kinds,
        can_be_root = EXCLUDED.can_be_root,
        root_min = EXCLUDED.root_min,
        root_max = EXCLUDED.root_max,
        sort_order = EXCLUDED.sort_order`
  }
  // P2.3 (#202) T4: prune the catalog-residue. Migration 038 UNCONDITIONALLY
  // seeds the StuRa default kinds (council/committee/group) into every DB, so a
  // non-default tenant whose blueprint upserts its own kinds still carries any
  // StuRa-only key with no municipal counterpart (e.g. `group`=Gruppe) — which
  // would leak into the user-facing kind picker (org-schema.ts reads
  // org_unit_kind). Delete every catalog row not in the blueprint's own schema.
  // Safe: org_units.kind FKs INTO org_unit_kind and this runs BEFORE
  // seedOrgUnits (runSeed order), so no org unit references the
  // about-to-be-pruned keys yet. Only reached when bp.orgSchema is present
  // (early-returned above otherwise) → StuRa carries none → no prune → tenant-#1
  // byte-identical.
  const keys = bp.orgSchema.map((k) => k.key)
  await sql`DELETE FROM org_unit_kind WHERE key <> ALL(${keys})`
}

/** SQL-row shape for a `caucus` insert (council key resolved to its org-unit id). */
export interface CaucusRow {
  key: string
  councilOrgUnitId: string
  name: string
  color: string | null
}
/** SQL-row shape for a `caucus_membership` insert. The council id is
 *  denormalized per D-CD so the one-faction-per-member-per-council UNIQUE
 *  holds as a plain constraint; the caucus DB id is resolved at insert time. */
export interface CaucusMembershipRow {
  caucusKey: string
  councilOrgUnitId: string
  userKeycloakId: string
  termStart: string | null
  termEnd: string | null
}

/** P2.2 (#202): pure row shaping for the caucus seeder — resolves blueprint
 *  keys to ids and throws on unresolvable references. Unit-testable; the DB
 *  inserts live in seedCaucuses (integration-verified post-#249). */
export function caucusRowsFromBlueprint(
  bp: Pick<GremionBlueprint, 'caucuses'>,
  orgUnitIdByKey: ReadonlyMap<string, string>,
  userIdByKey: ReadonlyMap<string, string>
): { caucus: CaucusRow[]; memberships: CaucusMembershipRow[] } {
  const caucus: CaucusRow[] = []
  const memberships: CaucusMembershipRow[] = []
  for (const c of bp.caucuses?.caucuses ?? []) {
    const councilOrgUnitId = orgUnitIdByKey.get(c.councilOrgUnitKey)
    if (councilOrgUnitId === undefined) {
      throw new Error(`caucusRowsFromBlueprint: unknown orgUnitKey "${c.councilOrgUnitKey}"`)
    }
    caucus.push({ key: c.key, councilOrgUnitId, name: c.name, color: c.color ?? null })
    for (const m of c.members) {
      const userKeycloakId = userIdByKey.get(m.userKey)
      if (userKeycloakId === undefined) {
        throw new Error(`caucusRowsFromBlueprint: unknown userKey "${m.userKey}"`)
      }
      memberships.push({
        caucusKey: c.key,
        councilOrgUnitId,
        userKeycloakId,
        termStart: m.termStart ?? null,
        termEnd: m.termEnd ?? null,
      })
    }
  }
  return { caucus, memberships }
}

/** P2.2 (#202): seed the blueprint's caucuses + memberships (migration 039).
 *  Idempotent via ON CONFLICT DO NOTHING on the natural uniques
 *  (caucus: council+name; membership: council+user). Returns the number of
 *  caucus rows in the blueprint (0 for StuRa — no caucuses section). */
export async function seedCaucuses(
  bp: Pick<GremionBlueprint, 'caucuses'>,
  orgUnitMap: ReadonlyMap<string, string>,
  userMap: ReadonlyMap<string, string>
): Promise<number> {
  const { caucus, memberships } = caucusRowsFromBlueprint(bp, orgUnitMap, userMap)
  if (caucus.length === 0) return 0
  const sql = getDb()
  const idByCaucusKey = new Map<string, string>()
  for (const c of caucus) {
    const inserted = await sql<Array<{ id: string }>>`
      INSERT INTO caucus (council_org_unit_id, name, color)
      VALUES (${c.councilOrgUnitId}, ${c.name}, ${c.color})
      ON CONFLICT (council_org_unit_id, name) DO NOTHING
      RETURNING id`
    let id = inserted[0]?.id
    if (id === undefined) {
      // conflict path (re-seed): the row already exists — fetch its id
      const existing = await sql<Array<{ id: string }>>`
        SELECT id FROM caucus
        WHERE council_org_unit_id = ${c.councilOrgUnitId} AND name = ${c.name}`
      id = existing[0]?.id
      if (id === undefined) {
        throw new Error(`seedCaucuses: caucus "${c.key}" neither inserted nor found`)
      }
    }
    idByCaucusKey.set(c.key, id)
  }
  for (const m of memberships) {
    const caucusId = idByCaucusKey.get(m.caucusKey)
    if (caucusId === undefined) {
      throw new Error(`seedCaucuses: unknown caucus key "${m.caucusKey}"`)
    }
    await sql`
      INSERT INTO caucus_membership
        (caucus_id, council_org_unit_id, user_keycloak_id, term_start, term_end)
      VALUES
        (${caucusId}, ${m.councilOrgUnitId}, ${m.userKeycloakId}, ${m.termStart}, ${m.termEnd})
      ON CONFLICT (council_org_unit_id, user_keycloak_id) DO NOTHING`
  }
  return caucus.length
}

/** Order org units so every parent precedes its children. */
function orderByDepth(bp: GremionBlueprint) {
  const byKey = new Map(bp.orgUnits.map((o) => [o.key, o]))
  const depth = (key: string): number => {
    let d = 0
    let cur = byKey.get(key)?.parentKey ?? null
    while (cur !== null) { d++; cur = byKey.get(cur)?.parentKey ?? null }
    return d
  }
  return [...bp.orgUnits].sort((a, b) => depth(a.key) - depth(b.key))
}

/** Create every org unit (parents first) and provision each across all subsystems. */
export async function seedOrgUnits(
  bp: GremionBlueprint,
  adapters: Adapters
): Promise<{ idMap: Map<string, string>; reports: Array<{ orgUnitKey: string; report: ProvisioningReport }> }> {
  const idMap = new Map<string, string>()
  const reports: Array<{ orgUnitKey: string; report: ProvisioningReport }> = []
  for (const ou of orderByDepth(bp)) {
    let parentId: string | null = null
    if (ou.parentKey) {
      const resolved = idMap.get(ou.parentKey)
      if (resolved === undefined) {
        throw new Error(`seedOrgUnits: parent org unit "${ou.parentKey}" not created before child "${ou.key}"`)
      }
      parentId = resolved
    }
    const created = await createOrgUnit({
      name: ou.name,
      description: ou.description,
      parentId,
      // Blueprint kinds are schema-validated strings (P2.2).
      kind: ou.kind,
      visibility: ou.visibility,
      wantsMatrixRoom: ou.wantsMatrixRoom,
      wantsNextcloudFolder: ou.wantsNextcloudFolder,
      childTerm: ou.childTerm ?? null,
      // P2.2 (#202): D-KL label override + §3.5(d) authority flag.
      kindLabel: ou.kindLabel ?? null,
      authority: ou.authority ?? 'deciding'
    })
    idMap.set(ou.key, created.id)
    const report = await provisionOrgUnit(created.id, adapters)
    reports.push({ orgUnitKey: ou.key, report })
  }
  return { idMap, reports }
}

/** Add every blueprint membership via the orchestrator (inserts the row and
 *  fans the member out to Keycloak / Matrix / Nextcloud). Returns the per-membership provisioning reports. */
export async function seedMemberships(
  bp: GremionBlueprint,
  userMap: Map<string, string>,
  orgUnitMap: Map<string, string>,
  adapters: Adapters
): Promise<ProvisioningReport[]> {
  const reports: ProvisioningReport[] = []
  for (const m of bp.memberships) {
    const orgUnitId = orgUnitMap.get(m.orgUnitKey)
    const userId = userMap.get(m.userKey)
    if (orgUnitId === undefined) throw new Error(`seedMemberships: unknown orgUnitKey "${m.orgUnitKey}"`)
    if (userId === undefined) throw new Error(`seedMemberships: unknown userKey "${m.userKey}"`)
    reports.push(await addMember(orgUnitId, userId, m.membershipType, m.termStart, m.termEnd, adapters))
    // P2.2 (#202, §3.5(d)): the orchestrator's addMember signature is owned by
    // the P2.1b track, so the voting flag rides the same idempotent upsert the
    // orchestrator just performed — re-applying the row with voting resolved.
    await addOrgUnitMember({
      orgUnitId,
      userKeycloakId: userId,
      membershipType: m.membershipType,
      termStart: m.termStart,
      termEnd: m.termEnd,
      voting: m.voting ?? true
    })
  }
  return reports
}

/** Create every blueprint role. Returns a roleKey -> role-id map. */
export async function seedRoles(
  bp: GremionBlueprint,
  orgUnitMap: Map<string, string>
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const r of bp.roles) {
    const orgUnitId = orgUnitMap.get(r.orgUnitKey)
    if (orgUnitId === undefined) throw new Error(`seedRoles: unknown orgUnitKey "${r.orgUnitKey}"`)
    const role = await createRole({
      orgUnitId,
      name: r.name,
      electionMethod: r.electionMethod,
      isElected: r.isElected,
      gracePeriodDays: SEED_GRACE_PERIOD_DAYS
    })
    map.set(r.key, role.id)
  }
  return map
}

/** Create every blueprint role assignment (status defaults to 'active'). */
export async function seedAssignments(
  bp: GremionBlueprint,
  roleMap: Map<string, string>,
  userMap: Map<string, string>
): Promise<void> {
  const assignedBy = userMap.get('dev.admin')
  if (!assignedBy) throw new Error('seedAssignments: dev.admin user id missing')
  for (const a of bp.assignments) {
    const roleId = roleMap.get(a.roleKey)
    const userId = userMap.get(a.userKey)
    if (roleId === undefined) throw new Error(`seedAssignments: unknown roleKey "${a.roleKey}"`)
    if (userId === undefined) throw new Error(`seedAssignments: unknown userKey "${a.userKey}"`)
    await createAssignment({
      roleId,
      userKeycloakId: userId,
      startDate: new Date(a.startDate),
      endDate: new Date(a.endDate),
      assignedByKeycloakId: assignedBy,
      heliosElectionId: null
    })
  }
}

/** dev.admin is the all-access development superuser. Beyond its it-admin realm
 *  role (which gates page access) it must hold *every* Keycloak group, so the
 *  access-token `groups` claim grants every group-gated action (KV/HV signing,
 *  admin). Idempotent — the Keycloak "add to group" PUT is a no-op when the user
 *  is already a member, so this is safe to re-run on every (re)seed. No-op if
 *  dev.admin is absent from the blueprint. */
export async function seedDevAdminGroups(
  kc: Pick<KeycloakAdminClient, 'listGroups' | 'addUserToGroup'>,
  userMap: Map<string, string>,
): Promise<void> {
  const devAdminId = userMap.get('dev.admin')
  if (!devAdminId) return
  const groups = await kc.listGroups()
  for (const g of groups) {
    await kc.addUserToGroup(devAdminId, g.id)
  }
}

export interface SeedDeps {
  kc?: KeycloakAdminClient
  adapters?: Adapters
  password?: string
  /** Seed the opt-in demo fixtures. Defaults to env SEED_DEMO_FIXTURES === 'true'. */
  includeDemo?: boolean
  /** Resolved tenant config. Defaults to readConfig(). */
  config?: GremionConfig
}

/** Validate the blueprint, then seed users -> org units -> memberships ->
 *  roles -> assignments. Throws only on an invalid blueprint or a
 *  Keycloak/database failure; subsystem hiccups self-heal via the worker. */
export async function runSeed(bp: GremionBlueprint, deps: SeedDeps = {}): Promise<SeedReport> {
  // P2.2 (#202): a blueprint carrying its own orgSchema is validated against
  // it (mirrors parseBlueprintDocument); absent → tenant-#1 default schema.
  const schema = bp.orgSchema ? orgSchemaFromBlueprint(bp.orgSchema) : GREMION_ORG_SCHEMA
  const problems = validateBlueprint(bp, schema)
  if (problems.length > 0) {
    throw new Error(`invalid blueprint: ${problems.join('; ')}`)
  }
  const password = deps.password ?? env.SEED_USER_PASSWORD
  if (!password) throw new Error('runSeed: SEED_USER_PASSWORD is not set')
  // P2.1b T4: out-of-request callers run inside an explicit runWithTenant
  // scope (worker entrypoints are wrapped by worker-fleet.ts
  // forEachActiveTenant), so the fail-closed default KC client resolves the
  // scoped tenant. Tests + the request-scoped /api/setup/seed route inject
  // deps.kc / have ALS from the resolution seam.
  const kc = deps.kc ?? getKeycloakAdminClientForCurrentTenant()
  const adapters = deps.adapters ?? defaultAdapters()
  const includeDemo = deps.includeDemo ?? env.SEED_DEMO_FIXTURES === 'true'

  const userMap = await seedUsers(bp, kc, password)
  await seedDevAdminGroups(kc, userMap)
  // P2.2 (#202): the kind catalog must exist before org units — the
  // org_units.kind FK (migration 038) references org_unit_kind.
  await seedOrgSchema(bp)
  const { idMap, reports } = await seedOrgUnits(bp, adapters)
  const membershipReports = await seedMemberships(bp, userMap, idMap, adapters)
  const caucuses = await seedCaucuses(bp, idMap, userMap)
  const roleMap = await seedRoles(bp, idMap)
  await seedAssignments(bp, roleMap, userMap)

  // Demo fixtures — opt-in via includeDemo. Idempotent, so a reseed does not
  // duplicate rows. The governance-only kernel ships the MUNICIPAL demo showcase
  // (a published Beschluss/protocol in an Ausschuss) — the legacy StuRa demo set
  // (calendar/elections/news/newsletter/board) rode with the now-carved-out
  // feature modules, so it is no longer seeded here. Other verticals that set a
  // non-municipal `demoSeeder` simply get no demo fixtures in the kernel.
  let demo: SeedReport['demo']
  if (includeDemo && (bp.demoSeeder ?? 'stura') === 'municipal') {
    const m = await seedMunicipalDemo(idMap, userMap)
    demo = {
      calendarEvents: m.calendarEvents,
      protocols: m.protocols,
    }
  }

  return {
    users: userMap.size,
    orgUnits: idMap.size,
    memberships: bp.memberships.length,
    caucuses,
    roles: roleMap.size,
    assignments: bp.assignments.length,
    provisioning: reports.map((r) => ({ orgUnitKey: r.orgUnitKey, overall: r.report.overall })),
    demo,
    errors: [
      ...reports
        .filter((r) => r.report.overall !== 'ok')
        .map((r) => `${r.orgUnitKey}: provisioning ${r.report.overall}`),
      ...membershipReports
        .filter((r) => r.overall !== 'ok')
        .map((r) => `membership fan-out ${r.orgUnitId}: ${r.overall}`)
    ]
  }
}
