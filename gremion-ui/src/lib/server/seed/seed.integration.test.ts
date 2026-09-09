import { describe, it, expect } from 'vitest'
import { seedUsers, seedOrgUnits, seedMemberships, seedRoles, seedAssignments, seedDevAdminGroups, runSeed } from './seed'
import { STURA_BLUEPRINT } from './org-blueprint'
import { MUNICIPAL_BLUEPRINT } from './municipal-blueprint'
import type { GremionConfig } from '../config'
import { getDb } from '../db'
import type { Adapters, ProvisioningSubsystem } from '../governance/provisioning/types'

function fakeKc() {
  return {
    nextId: 0,
    created: [] as Array<{ username: string }>,
    roleAssignments: [] as Array<[string, string]>, // [userId, roleName]
    existing: new Map<string, string>(),            // username -> id (pre-existing users)
    async createUser(data: { username: string }) {
      if (this.existing.has(data.username)) throw new Error('409 user exists')
      this.created.push({ username: data.username })
      // Real Keycloak mints UUIDs; some columns (e.g. committee_elections.created_by)
      // are UUID-typed, so the fake must hand back UUID-shaped ids too. Deterministic
      // for stable assertions.
      const id = `00000000-0000-4000-8000-${String(++this.nextId).padStart(12, '0')}`
      this.existing.set(data.username, id)
      return id
    },
    async listUsers(opts: { search?: string }) {
      if (!opts.search) throw new Error('fakeKc: listUsers called with empty search')
      const id = this.existing.get(opts.search)
      return id ? [{ id, username: opts.search }] : []
    },
    async listRealmRoles() {
      return ['guest', 'member', 'finance', 'council-admin', 'it-admin'].map((n) => ({ id: `role-${n}`, name: n }))
    },
    async assignRoles(userId: string, roles: Array<{ name: string }>) {
      for (const r of roles) this.roleAssignments.push([userId, r.name])
    },
    groupMembers: [] as Array<[string, string]>, // [userId, groupId]
    async listGroups() {
      // mirrors the sturaos realm-export.json groups
      return ['login', 'ref-finanzen', 'ref-finanzen-belege', 'ref-finanzen-kv', 'ref-finanzen-hv', 'admin']
        .map((n) => ({ id: `grp-${n}`, name: n, path: `/${n}` }))
    },
    async addUserToGroup(userId: string, groupId: string) {
      this.groupMembers.push([userId, groupId])
    }
  }
}

describe('seedDevAdminGroups', () => {
  it('adds dev.admin to every Keycloak group', async () => {
    const kc = fakeKc()
    await seedDevAdminGroups(kc as never, new Map([['dev.admin', 'kc-dev']]))
    expect(kc.groupMembers).toHaveLength(6)
    expect(kc.groupMembers.every(([u]) => u === 'kc-dev')).toBe(true)
    expect(kc.groupMembers.map(([, g]) => g)).toContain('grp-ref-finanzen-hv')
  })
  it('is a no-op when dev.admin is absent from the user map', async () => {
    const kc = fakeKc()
    await seedDevAdminGroups(kc as never, new Map([['anna.berger', 'kc-1']]))
    expect(kc.groupMembers).toHaveLength(0)
  })
})

describe('seedUsers', () => {
  it('creates every blueprint user and assigns its realm role', async () => {
    const kc = fakeKc()
    const map = await seedUsers(STURA_BLUEPRINT, kc as never, 'pw')
    expect(kc.created).toHaveLength(15)
    expect(map.size).toBe(15)
    // dev.admin must get the it-admin realm role
    const devId = map.get('dev.admin')!
    expect(kc.roleAssignments).toContainEqual([devId, 'it-admin'])
  })

  it('reuses an already-existing Keycloak user instead of failing', async () => {
    const kc = fakeKc()
    kc.existing.set('anna.berger', 'kc-existing-anna')
    const map = await seedUsers(STURA_BLUEPRINT, kc as never, 'pw')
    expect(map.get('anna.berger')).toBe('kc-existing-anna')
    expect(kc.created.find((c) => c.username === 'anna.berger')).toBeUndefined()
  })
})

function recordingAdapter(name: ProvisioningSubsystem['name'], log: string[]): ProvisioningSubsystem {
  let n = 0
  return {
    name,
    async ensureResource(unit) { log.push(`${name}:${unit.name}`); return { externalId: `${name}-${++n}` } },
    async removeResource() {},
    async addMember() {}, async removeMember() {}, async reconcileMembers() {}
  }
}
function fakeAdapters(log: string[]): Adapters {
  return {
    keycloak: recordingAdapter('keycloak', log),
    matrix: recordingAdapter('matrix', log),
    nextcloud: recordingAdapter('nextcloud', log)
  }
}

describe('seedOrgUnits', () => {
  it('creates all org units and provisions parents before children', async () => {
    const sql = getDb()
    // Carve note: the finance.* schema is not part of the governance-only
    // kernel, so its teardown is gone — only governance tables are cleared.
    await sql`DELETE FROM provisioning_resources`
    await sql`DELETE FROM org_unit_members`
    await sql`TRUNCATE org_units RESTART IDENTITY CASCADE`
    await sql`DELETE FROM org_units`

    const log: string[] = []
    const { idMap, reports } = await seedOrgUnits(STURA_BLUEPRINT, fakeAdapters(log))

    expect(idMap.size).toBe(11)
    expect(reports).toHaveLength(11)
    // the council is provisioned before the Vorstand; the Vorstand before IT-Team
    const kcLog = log.filter((l) => l.startsWith('keycloak:'))
    expect(kcLog.indexOf('keycloak:Studierendenrat')).toBeLessThan(kcLog.indexOf('keycloak:Vorstand'))
    expect(kcLog.indexOf('keycloak:Vorstand')).toBeLessThan(kcLog.indexOf('keycloak:IT-Team'))
    // the child org unit has its parent id wired
    const itTeamId = idMap.get('it-team')!
    const rows = await sql`SELECT parent_id FROM org_units WHERE id = ${itTeamId}`
    expect(rows[0].parent_id).toBe(idMap.get('vorstand'))
  })
})

describe('seedMemberships', () => {
  it('adds every blueprint membership row', async () => {
    const sql = getDb()
    // Carve note: the finance.* schema is not part of the governance-only
    // kernel, so its teardown is gone — only governance tables are cleared.
    await sql`DELETE FROM provisioning_resources`
    await sql`DELETE FROM org_unit_members`
    await sql`TRUNCATE org_units RESTART IDENTITY CASCADE`
    await sql`DELETE FROM org_units`

    const { idMap } = await seedOrgUnits(STURA_BLUEPRINT, fakeAdapters([]))
    // a synthetic user map: every blueprint user -> a fake uuid
    const userMap = new Map(STURA_BLUEPRINT.users.map((u, i) => [u.username, `uuid-${i}`]))

    await seedMemberships(STURA_BLUEPRINT, userMap, idMap, fakeAdapters([]))

    const count = await sql`SELECT COUNT(*)::int AS c FROM org_unit_members`
    expect(count[0].c).toBe(STURA_BLUEPRINT.memberships.length)
    // dev.admin is an employee member of the council
    const devRows = await sql`
      SELECT membership_type FROM org_unit_members
      WHERE org_unit_id = ${idMap.get('studierendenrat')!}
        AND user_keycloak_id = ${userMap.get('dev.admin')!}`
    expect(devRows[0].membership_type).toBe('employee')
  })
})

describe('seedRoles + seedAssignments', () => {
  it('creates every role and assignment', async () => {
    const sql = getDb()
    await sql`DELETE FROM role_assignments`
    await sql`DELETE FROM committee_roles`
    // Carve note: the finance.* schema is not part of the governance-only
    // kernel, so its teardown is gone — only governance tables are cleared.
    await sql`DELETE FROM provisioning_resources`
    await sql`DELETE FROM org_unit_members`
    await sql`TRUNCATE org_units RESTART IDENTITY CASCADE`
    await sql`DELETE FROM org_units`

    const { idMap } = await seedOrgUnits(STURA_BLUEPRINT, fakeAdapters([]))
    const userMap = new Map(STURA_BLUEPRINT.users.map((u, i) => [u.username, `uuid-${i}`]))

    const roleMap = await seedRoles(STURA_BLUEPRINT, idMap)
    expect(roleMap.size).toBe(8)
    const itRole = await sql`SELECT election_method, is_elected FROM committee_roles WHERE id = ${roleMap.get('it-verantwortung')!}`
    expect(itRole[0].election_method).toBe('manual')
    expect(itRole[0].is_elected).toBe(false)

    await seedAssignments(STURA_BLUEPRINT, roleMap, userMap)
    const count = await sql`SELECT COUNT(*)::int AS c FROM role_assignments`
    expect(count[0].c).toBe(8)
  })
})

describe('runSeed', () => {
  it('seeds users, org units, memberships, roles and assignments end-to-end (governance-only)', async () => {
    // Carve note: the finance feature module (and its `finance.*` schema) is not
    // part of the governance-only kernel, so this end-to-end seed asserts the
    // governance counts only — there is no finance section on the SeedReport.
    const sql = getDb()
    await sql`DELETE FROM role_assignments`
    await sql`DELETE FROM committee_roles`
    await sql`DELETE FROM provisioning_resources`
    await sql`DELETE FROM org_unit_members`
    await sql`TRUNCATE org_units RESTART IDENTITY CASCADE`
    await sql`DELETE FROM org_units`

    const report = await runSeed(STURA_BLUEPRINT, {
      kc: fakeKc() as never,
      adapters: fakeAdapters([]),
      password: 'pw'
    })

    expect(report.errors).toEqual([])
    // governance counts are present and non-zero — the green-seed acceptance
    expect(report.users).toBeGreaterThanOrEqual(STURA_BLUEPRINT.users.length)
    expect(report.orgUnits).toBe(STURA_BLUEPRINT.orgUnits.length)
    expect(report.roles).toBe(STURA_BLUEPRINT.roles.length)
    expect(report.assignments).toBe(STURA_BLUEPRINT.assignments.length)
  })

  it('throws on an invalid blueprint before touching any system', async () => {
    const bad = { ...STURA_BLUEPRINT, users: [] }
    await expect(runSeed(bad, { kc: fakeKc() as never, adapters: fakeAdapters([]), password: 'pw' }))
      .rejects.toThrow(/invalid blueprint/i)
  })
})

describe('runSeed demo fixtures (governance-only kernel — municipal showcase)', () => {
  // Carve note: the StuRa demo seeders (calendar/elections/news/newsletter/board)
  // rode out with their feature modules. The only demo seeder left is the
  // MUNICIPAL showcase, which seeds a published Beschluss/protocol in an Ausschuss
  // via the kept governance protocol-db. (The former calendar entry is also
  // carved out, so calendarEvents is always 0.)
  it('seeds the municipal governance demo (a published protocol) under includeDemo', async () => {
    const sql = getDb()
    await sql`DELETE FROM protocol_action_items`
    await sql`DELETE FROM protocol_resolutions`
    await sql`DELETE FROM protocol_attendance`
    await sql`DELETE FROM protocols`
    await sql`DELETE FROM role_assignments`
    await sql`DELETE FROM committee_roles`
    await sql`DELETE FROM caucus_membership`
    await sql`DELETE FROM caucus`
    await sql`DELETE FROM provisioning_resources`
    await sql`DELETE FROM org_unit_members`
    await sql`TRUNCATE org_units RESTART IDENTITY CASCADE`
    await sql`DELETE FROM org_units`

    const report = await runSeed(MUNICIPAL_BLUEPRINT, {
      kc: fakeKc() as never,
      adapters: fakeAdapters([]),
      password: 'pw',
      includeDemo: true,
    })

    // Report carries the municipal demo counts (calendar carved out → 0).
    expect(report.errors).toEqual([])
    expect(report.demo).toBeDefined()
    expect(report.demo!.calendarEvents).toBe(0)
    expect(report.demo!.protocols).toBe(1)

    // ── one published Beschluss/protocol in the Hauptausschuss ────────────
    const protocols = await sql<{ id: string; title: string; status: string }[]>`
      SELECT id, title, status FROM protocols ORDER BY title`
    expect(protocols).toHaveLength(1)
    const proto = protocols[0]
    expect(proto.status).toBe('published')
    const resolutions = await sql<{ result: string }[]>`
      SELECT result FROM protocol_resolutions WHERE protocol_id = ${proto.id}`
    expect(resolutions).toHaveLength(1)
    expect(resolutions[0].result).toBe('passed')
  })
})

// P2.3 (#202) T4 — catalog-residue prune. Migration 038 unconditionally seeds
// the three StuRa kinds (council/committee/group) into EVERY DB. A municipal
// tenant's blueprint upserts its own kinds but the StuRa-only `group=Gruppe`
// row has no municipal counterpart, so without a prune it survives and leaks
// into the user-facing kind picker (org-schema.ts reads org_unit_kind). The
// prune in seedOrgSchema deletes any catalog row whose key is not in the
// blueprint's own orgSchema — but ONLY when the blueprint carries an orgSchema
// (StuRa carries none → no prune → tenant-#1 byte-identical).
describe('seedOrgSchema catalog prune (P2.3 T4)', () => {
  // Shared teardown mirroring the runSeed test: clear everything a seed run
  // touches, child→parent order, so each blueprint seeds into a clean DB.
  async function resetSeedTables() {
    // Carve note: the finance.* schema is not part of the governance-only kernel,
    // so the finance teardown is gone — only the governance tables are cleared.
    const sql = getDb()
    await sql`DELETE FROM caucus_membership`
    await sql`DELETE FROM caucus`
    await sql`DELETE FROM role_assignments`
    await sql`DELETE FROM committee_roles`
    await sql`DELETE FROM provisioning_resources`
    await sql`DELETE FROM org_unit_members`
    await sql`TRUNCATE org_units RESTART IDENTITY CASCADE`
    await sql`DELETE FROM org_units`
    // The catalog rows survive an org-unit teardown (org_units.kind FKs INTO
    // org_unit_kind, not the other way round). Restore the migration-038
    // defaults so each test starts from the exact post-migration baseline a
    // fresh tenant DB has — incl. the StuRa-only `group` row the prune targets.
    await sql`DELETE FROM org_unit_kind`
    await sql`
      INSERT INTO org_unit_kind
        (key, label, child_term, allowed_parent_kinds, can_be_root, root_min, root_max, sort_order)
      VALUES
        ('council',   'Gremium', 'Referate',       '{}',                        true,  1, 1,    0),
        ('committee', 'Referat', 'Arbeitsgruppen', '{council,committee}',       false, 0, 0,    1),
        ('group',     'Gruppe',  NULL,             '{council,committee,group}', true,  0, NULL, 2)`
  }

  // Governance-only kernel: no feature modules toggle here. A minimal config is
  // enough for the catalog-prune path (the seeder reads config only generically).
  const KERNEL_CONFIG = {
    modules: {}
  } as unknown as GremionConfig

  it('prunes the StuRa default kinds, leaving EXACTLY the municipal catalog', async () => {
    const sql = getDb()
    await resetSeedTables()

    const report = await runSeed(MUNICIPAL_BLUEPRINT, {
      kc: fakeKc() as never,
      adapters: fakeAdapters([]),
      password: 'pw',
      config: KERNEL_CONFIG,
    })
    expect(report.errors).toEqual([])

    const kinds = await sql<{ key: string }[]>`SELECT key FROM org_unit_kind ORDER BY key`
    expect(kinds.map((k) => k.key)).toEqual(['administration', 'committee', 'council', 'district_council'])
    // The StuRa-only residue is gone.
    const gruppe = await sql<{ c: number }[]>`SELECT COUNT(*)::int AS c FROM org_unit_kind WHERE key = 'group'`
    expect(gruppe[0].c).toBe(0)
    // The municipal labels won (upsert), not StuRa's.
    const council = await sql<{ label: string }[]>`SELECT label FROM org_unit_kind WHERE key = 'council'`
    expect(council[0].label).toBe('Gemeinderat')
  })

  it('leaves the migration-038 default kinds untouched for the StuRa blueprint (no prune)', async () => {
    const sql = getDb()
    await resetSeedTables()

    const report = await runSeed(STURA_BLUEPRINT, {
      kc: fakeKc() as never,
      adapters: fakeAdapters([]),
      password: 'pw',
    })
    expect(report.errors).toEqual([])

    // StuRa carries no orgSchema → seedOrgSchema is a no-op → the three
    // migration-038 default rows survive byte-identically (incl. `group`).
    const kinds = await sql<{ key: string }[]>`SELECT key FROM org_unit_kind ORDER BY key`
    expect(kinds.map((k) => k.key)).toEqual(['committee', 'council', 'group'])
  })
})
