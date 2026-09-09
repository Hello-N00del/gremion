/**
 * P2.3 (#202) — Municipal-vertical acceptance suite.
 *
 * Proves the "Stadt Musterstadt" municipal council (Gemeinderat) vertical stands
 * up as a GENUINELY DIFFERENT, finance-OFF tenant from the SAME framework: it
 * boots finance-OFF, renders municipal vocabulary (Gemeinderat/Ausschuss/
 * Fraktion/Ortschaftsrat) with NO StuRa-kind leakage, models a councillor in one
 * Fraktion across multiple Ausschüsse, isolates the data-plane DB per tenant
 * (LiveKit/newsletter are leaf-service concerns outside kernel scope), and
 * carries the §4 realm contract.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS TEST IS A DELIBERATELY-STANDALONE STAGING/LOCAL STEP — NOT a CI lane.
 * It lives under tests/integration/** (outside `src/**`), so neither the unit
 * lane nor the shared FINANCE-ON integration lane collects it. It is collectable
 * ONLY via the dedicated finance-OFF deselection lane whose `include` matches
 * tests/integration/**:
 *     pnpm -C gremion-ui test:deselection
 *   (= vitest run --config vitest.deselection.config.ts)
 * See tests/integration/README.md for the full runbook + env.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW TO RUN (DB criteria 1–3 + structural 4–6):
 *   1. Stand up a FRESH, isolated, EMPTY Postgres and export DATABASE_URL at it
 *      (NEVER the live/staging DB — the proof is about what a fresh municipal
 *      init does and does NOT create).
 *   2. (optional) export CONFIG_PATH=<a config.json that exists in this repo>
 *      — gremion#22: the old `examples/verticals/musterstadt/config.json`
 *      fixture this pointed at was removed with the demo-verticals carve and
 *      no longer exists. It is not load-bearing here either: finance is
 *      carved out of this kernel unconditionally, so runMigrations() never
 *      reads a modules.finance flag. See tests/integration/README.md.
 *   3. pnpm -C gremion-ui test:deselection
 *      (this is the only file in that lane — deselection-boot.integration.test.ts
 *      was deleted (gremion#22): its DB criteria were already subsumed here, and
 *      finance is unconditionally carved out of this kernel, so its whole
 *      premise — toggling a *present* finance module — no longer applies).
 *
 * Env-gated optional criterion:
 *   - MUSTERSTADT_RECONCILE_VERIFY=1 enables criterion 7 — it shells out to the
 *     CLI `tenant-provision reconcile --verify-only musterstadt`, the R5/R7 §4
 *     realm-contract drift guard, against a THROWAWAY musterstadt realm (mirrors
 *     deselection criterion 4's KC-Admin gating — never runs by absence).
 *
 * Criteria covered here:
 *   (1)  Boots finance-OFF: no finance schema / migration rows; governance present.
 *   (2)  Municipal vocabulary renders — EXACTLY the 4 municipal kinds, no leakage.
 *   (3)  A councillor sits in one Fraktion + multiple Ausschüsse.
 *   (4)  Distinct data-plane DB name (t_musterstadt) — registry-level.
 *   (5)  LiveKit token mint is tenant-scoped (cross-tenant room rejected).
 *   (6)  Newsletter module is ABSENT from the kernel manifest registry
 *        (carved out, gremion#22) — a tenant that wants it gets it from the
 *        modules overlay (gremion-modules), out of kernel scope.
 *   (7)  Realm contract via reconcile --verify-only            [env-gated]
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { getDb, runMigrations } from '$lib/server/db'
import { runSeed } from '$lib/server/seed/seed'
import { loadOrgSchema } from '$lib/server/governance/org-schema'
import { MUNICIPAL_BLUEPRINT } from '$lib/server/seed/municipal-blueprint'
import { dbNameForSlug } from '$lib/server/tenant/slug'
import { MODULE_MANIFESTS } from '$lib/modules/registry'
import type { GremionConfig } from '$lib/server/config'
import type { Adapters, ProvisioningSubsystem } from '$lib/server/governance/provisioning/types'

const MUSTERSTADT_SLUG = 'musterstadt'

let seedReport: Awaited<ReturnType<typeof runSeed>>

// ── fakeKc / fakeAdapters mirror seed.integration.test.ts ───────────────────
function fakeKc() {
  return {
    nextId: 0,
    created: [] as Array<{ username: string }>,
    roleAssignments: [] as Array<[string, string]>,
    existing: new Map<string, string>(),
    async createUser(data: { username: string }) {
      if (this.existing.has(data.username)) throw new Error('409 user exists')
      this.created.push({ username: data.username })
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
      return ['guest', 'member', 'council-admin', 'it-admin'].map((n) => ({ id: `role-${n}`, name: n }))
    },
    async assignRoles(userId: string, roles: Array<{ name: string }>) {
      for (const r of roles) this.roleAssignments.push([userId, r.name])
    },
    groupMembers: [] as Array<[string, string]>,
    async listGroups() {
      // A finance-OFF municipal realm carries no ref-finanzen groups.
      return ['login', 'admin'].map((n) => ({ id: `grp-${n}`, name: n, path: `/${n}` }))
    },
    async addUserToGroup(userId: string, groupId: string) {
      this.groupMembers.push([userId, groupId])
    },
  }
}

function recordingAdapter(name: ProvisioningSubsystem['name']): ProvisioningSubsystem {
  let n = 0
  return {
    name,
    async ensureResource() {
      return { externalId: `${name}-${++n}` }
    },
    async removeResource() {},
    async addMember() {},
    async removeMember() {},
    async reconcileMembers() {},
  }
}
function fakeAdapters(): Adapters {
  return {
    keycloak: recordingAdapter('keycloak'),
    matrix: recordingAdapter('matrix'),
    nextcloud: recordingAdapter('nextcloud'),
  }
}

// Municipal runs finance-OFF (P0.2) — inject a finance-disabled config so
// shouldSeedFinance skips the (empty) finance section entirely.
const FINANCE_OFF_CONFIG = {
  modules: { files: true, messages: true, calendar: true, users: true, finance: false, elections: true },
} as unknown as GremionConfig

describe('P2.3 municipal-vertical acceptance (finance OFF)', () => {
  beforeAll(async () => {
    // (1) boot: finance is carved out of this kernel unconditionally (gremion#22)
    // — there is no finance.ts module manifest and no finance migrations exist
    // to run, regardless of CONFIG_PATH. See tests/integration/README.md.
    await runMigrations()
    // (2)/(3) seed the municipal blueprint (its OWN kind catalog, org units,
    // Fraktionen) into the fresh finance-OFF DB. fakeKc/fakeAdapters per
    // seed.integration.test.ts; finance-OFF config so shouldSeedFinance skips.
    //
    // includeDemo:true MATCHES the live staging env (.env SEED_DEMO_FIXTURES=true,
    // which the /api/setup/seed route reads via runSeed's default). The StuRa demo
    // seeders are hardcoded to StuRa keys and would THROW on this blueprint; the
    // municipal demo path (bp.demoSeeder='municipal') must run instead and produce
    // believable content — this is the configuration the operator's live seed uses.
    seedReport = await runSeed(MUNICIPAL_BLUEPRINT, {
      kc: fakeKc() as never,
      adapters: fakeAdapters(),
      password: 'pw',
      config: FINANCE_OFF_CONFIG,
      includeDemo: true,
    })
    expect(seedReport.errors).toEqual([])
  })

  // ── (1) boots finance-OFF: severability ───────────────────────────────────
  it('(1) does NOT create the finance schema (finance OFF)', async () => {
    const sql = getDb()
    const rows = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.schemata WHERE schema_name = 'finance'
      ) AS exists`
    expect(rows[0].exists).toBe(false)
  })

  it('(1) records NO finance migration, but DID migrate governance (severability)', async () => {
    const sql = getDb()
    const finance = await sql<{ filename: string }[]>`
      SELECT filename FROM schema_migrations
      WHERE filename ILIKE '%finance%' OR filename ILIKE '%approval%'`
    expect(finance).toHaveLength(0)
    // governance org_units (001→010) present → the run did not silently abort.
    const gov = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'org_units'
      ) AS exists`
    expect(gov[0].exists).toBe(true)
  })

  // ── (2) municipal vocabulary renders, NO StuRa-kind leakage ────────────────
  it('(2) the kind catalog is EXACTLY the 4 municipal kinds (no StuRa leakage)', async () => {
    const schema = await loadOrgSchema()
    expect(Object.keys(schema.kinds).sort()).toEqual([
      'administration',
      'committee',
      'council',
      'district_council',
    ])
    // the StuRa-only `group`=Gruppe residue (migration 038) was pruned (T4).
    expect('group' in schema.kinds).toBe(false)
  })

  it('(2) the municipal labels render (Gemeinderat / Ausschuss / Ortschaftsrat)', async () => {
    const schema = await loadOrgSchema()
    expect(schema.kinds.council?.label).toBe('Gemeinderat')
    expect(schema.kinds.committee?.label).toBe('Ausschuss')
    expect(schema.kinds.district_council?.label).toBe('Ortschaftsrat')
    // a seeded org unit resolves to the municipal kind label, not a StuRa one.
    const sql = getDb()
    const rows = await sql<{ name: string; kind: string }[]>`
      SELECT name, kind FROM org_units WHERE kind = 'committee' ORDER BY name`
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(schema.kinds[rows[0].kind]?.label).toBe('Ausschuss')
  })

  // ── (3) a councillor: ONE Fraktion + MULTIPLE Ausschüsse ───────────────────
  it('(3) councillor1 sits in exactly one Fraktion and >= 2 Ausschüsse', async () => {
    const sql = getDb()
    // councillor1 is the only member sitting on the Hauptausschuss — resolve its
    // keycloak id through org_unit_members (the fake KC mints opaque UUIDs).
    const councillor = await sql<{ id: string }[]>`
      SELECT oum.user_keycloak_id AS id
      FROM org_unit_members oum
      JOIN org_units o ON o.id = oum.org_unit_id
      WHERE o.name = 'Hauptausschuss'
      LIMIT 1`
    expect(councillor).toHaveLength(1)
    const councillorId = councillor[0].id

    // exactly ONE Fraktion (caucus_membership) on the Gemeinderat council.
    const caucus = await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c
      FROM caucus_membership cm
      WHERE cm.user_keycloak_id = ${councillorId}`
    expect(caucus[0].c).toBe(1)

    // >= 2 Ausschuss (kind='committee') memberships.
    const committees = await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c
      FROM org_unit_members oum
      JOIN org_units o ON o.id = oum.org_unit_id
      WHERE o.kind = 'committee' AND oum.user_keycloak_id = ${councillorId}`
    expect(committees[0].c).toBeGreaterThanOrEqual(2)
  })

  // ── Component 3: municipal demo content (clickable showcase, not bare shell) ─
  // The design Goal + Decision require "believable demo content, not a bare shell"
  // seeded via the per-tenant seed path WITH includeDemo (the staging env). These
  // also prove the StuRa-hardcoded demo seeders did NOT run (they would throw on
  // this blueprint) — the municipal demo path ran instead.
  it('(demo) boots green WITH includeDemo (matching the staging env)', () => {
    // beforeAll already asserts report.errors empty; this names the regression:
    // the live seed runs includeDemo=true and MUST NOT throw on the municipal
    // blueprint (the StuRa seeders' ou('studierendenrat') / user('anna.berger')).
    expect(seedReport.errors).toEqual([])
    expect(seedReport.demo).toBeDefined()
  })

  it('(demo) seeds >= 1 Beschluss/protocol in an Ausschuss', async () => {
    const sql = getDb()
    // a published protocol attached to a committee whose kind is the municipal
    // 'committee' (Ausschuss) — a real, clickable governance artifact.
    const rows = await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c
      FROM protocols p
      JOIN org_units o ON o.id = p.committee_id
      WHERE o.kind = 'committee'`
    expect(rows[0].c).toBeGreaterThanOrEqual(1)
    // and it carries a Beschluss (resolution) — the clickable content.
    const res = await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c
      FROM protocol_resolutions pr
      JOIN protocols p ON p.id = pr.protocol_id
      JOIN org_units o ON o.id = p.committee_id
      WHERE o.kind = 'committee'`
    expect(res[0].c).toBeGreaterThanOrEqual(1)
    expect(seedReport.demo?.protocols).toBeGreaterThanOrEqual(1)
  })

  it('(demo) does NOT seed calendar entries (calendar module carved out of kernel)', async () => {
    // Carve note (gremion#22): this used to assert `>= 1` calendar entry via a
    // direct `calendar_events` query. The calendar feature module rode out
    // with the other StuRa feature modules (see seed-municipal-demo.ts's carve
    // note) — there is no `calendar_events` table in this kernel's schema, so
    // that query would fail with "relation does not exist" if it ever ran.
    // seedMunicipalDemo() always reports calendarEvents: 0 now (kept on the
    // report shape for backward compatibility); assert that instead.
    expect(seedReport.demo?.calendarEvents).toBe(0)
  })

  it('(demo) did NOT seed StuRa demo content (no StuRa-keyed leakage)', async () => {
    const sql = getDb()
    // The StuRa seeders create "Plenum Nr. 247" / "StuRa-Plenum Nr. 247"; their
    // absence proves the municipal demo path ran, not the StuRa-hardcoded one.
    const gremion = await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM protocols WHERE title ILIKE 'Plenum Nr. 247%'`
    expect(gremion[0].c).toBe(0)
  })

  // ── (4) distinct data-plane DB name — registry-level ───────────────────────
  it('(4) the municipal tenant resolves to a DISTINCT data-plane DB (t_musterstadt)', () => {
    const muni = dbNameForSlug(MUSTERSTADT_SLUG)
    expect(muni).toBe('t_musterstadt')
    // not the shared `gremion` DB and not equal to another tenant's t_<slug>.
    expect(muni).not.toBe('gremion')
    expect(muni).not.toBe(dbNameForSlug('demo'))
  })

  // (5) — carved out: the LiveKit token-namespace tenant-isolation check rode
  // with the (now-carved-out) messages/video feature module. The remaining
  // multi-tenant isolation guarantees (DB namespace, newsletter module
  // absence, realm contract) are covered by the surrounding cases.

  // ── (6) newsletter module is ABSENT from the kernel — registry-level ───────
  it('(6) the newsletter module is NOT registered in the kernel manifest set', () => {
    // gremion#22: the old criterion here asserted `newsletter_${slug} ===
    // 'newsletter_musterstadt'` — a tautology against its own input, proving
    // nothing about the kernel. The newsletter feature was carved out of the
    // kernel (see registry.test.ts's KERNEL_MANIFEST_IDS = ['core',
    // 'governance']); the real, checkable municipal-vertical guarantee is that
    // this finance-OFF tenant boots on a manifest set that never registered a
    // newsletter module in the first place — there is no per-tenant leaf state
    // for it to leak across tenants here. A tenant that wants the newsletter
    // module gets it from the modules overlay (gremion-modules), out of scope
    // for this kernel-level acceptance suite.
    expect(MODULE_MANIFESTS.map((m) => m.id)).not.toContain('newsletter')
  })

  // ── (7) realm contract via reconcile --verify-only ────────[env-gated]──────
  // Mirrors deselection criterion 4's KC-Admin gating: shells out to the CLI
  // R5/R7 §4 drift guard against a THROWAWAY musterstadt realm. Asserts the CLI
  // exits 0 (every §4 check — protocol-mapper, acr.loa.map, browser-stepup,
  // sslRequired=all — PASSES). Skips by absence so the file always compiles and
  // criteria 1–6 run without a live KC.
  it.skipIf(!process.env.MUSTERSTADT_RECONCILE_VERIFY)(
    '(7) the provisioned realm passes reconcile --verify-only (§4 contract)',
    () => {
      // The CLI reads DOMAIN / KC creds / control DB from the operator env; a
      // non-zero exit (FAIL or error) throws and fails this case.
      expect(() =>
        execFileSync(
          'node',
          ['--import', 'tsx', 'scripts/tenant-provision.ts', 'reconcile', '--verify-only', MUSTERSTADT_SLUG],
          { stdio: 'pipe' },
        ),
      ).not.toThrow()
    },
  )
})
