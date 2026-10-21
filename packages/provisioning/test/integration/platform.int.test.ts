// TASK-043 TDD 4 and TDD 7 (database half) on one scratch PostgreSQL 18
// (test/integration/run.mjs) that holds NO gremion_platform at the start:
//  - enabling anything before `init` fails (RED without init, Q15);
//  - bootstrapPlatform creates, migrates and loads the catalogue rows (Q20),
//    and a rerun changes nothing;
//  - pgLedger round-trips against 0004; pgGate records a DPIA decision once;
//  - TASK-044: pgModules enables calendar through the REAL gate (pgGate over
//    lifecycle/enable-gate) with the imported verify pass and the recorded
//    decision as its references; vault and publishing (no pass) are refused
//    by EnableRefused with no database; a module Q20 left undecided is
//    MODULE_VERSION_UNKNOWN; a moved tip makes the enabled modules unproven.
import { randomBytes, randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LifecycleModule, ModuleServer } from '@gremion/tenant-store/lifecycle'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  bootstrapPlatform,
  EnableRefused,
  ensurePanelRequester as ensurePanelReader,
  isDuplicateDone,
  loadModuleJsons,
  pgGate,
  pgLedger,
  pgModules,
  recordIsolationResults,
  type DpiaSpec,
} from '../../src/index.ts'

const TIP = 'e'.repeat(40)
const DPIA: DpiaSpec = { requiresDpia: 'no', reasonCodes: ['no_special_category'], documentRef: 'TOM-Anhang 4.1' }

/** A verify-stamped isolation:tenant PASS on `tip` for `modules` (what verify writes, lane note S5). */
function evidence(modules: string[], tip = TIP) {
  return {
    produced_by: 'verify',
    tree_clean: true,
    release_tip_sha: tip,
    verify_record: { suite: 'isolation:tenant', sha: tip, startedAt: '2026-10-05T10:00:00.000Z', finishedAt: '2026-10-05T10:03:00.000Z', collected: 8, passed: 8, failed: 0 },
    results: modules.map((m) => ({ module: m, test_kind: 'cross_customer', passed: true, run_at: '2026-10-05T10:02:00.000Z', release_tip_sha: tip, evidence_ref: `sha256:${'0'.repeat(64)} isolation/${tip}.json#${m}` })),
  }
}

const REPO = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))
const OWNER = 't043_platform'
const OWNER_PW = randomBytes(24).toString('base64url')
const APP_PW = randomBytes(24).toString('base64url')
const OPERATOR = randomUUID()

function adminUrl(db = 'postgres', user?: string, password?: string): string {
  const raw = process.env.T043_PG_ADMIN_URL
  if (!raw) throw new Error('T043_PG_ADMIN_URL is unset: run through `pnpm test:integration` (test/integration/run.mjs)')
  const u = new URL(raw)
  if (u.hostname !== '127.0.0.1' || decodeURIComponent(u.username) !== 't043_admin') throw new Error('[t043] refusing a database url that is not the scratch server')
  u.pathname = `/${db}`
  if (user) u.username = user
  if (password) u.password = encodeURIComponent(password)
  return u.toString()
}

const open = (db = 'postgres', max = 2, user?: string, password?: string): Sql =>
  postgres(adminUrl(db, user, password), { max, onnotice: () => {}, connect_timeout: 10 })

function uuidv7(): string {
  const b = randomBytes(16)
  const ms = BigInt(Date.now())
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn)
  b[6] = (b[6]! & 0x0f) | 0x70
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// The catalogue as the tenant-provision CLI reads it (one entry per modules/<id>
// with a module.json): the shared loadModuleJsons (R29-LOW-07 L5). It lives in
// this package, not in @gremion/module-catalogue, whose package root does not
// type-check under this package's stricter flags.
const MODULES = resolve(REPO, 'modules')
const catalogue: LifecycleModule[] = loadModuleJsons(MODULES)

/** Every in-tree module: 11 since R29-I24 (the five database-less ones load under provisional profiles). */
const ALL_MODULES = catalogue.map((m) => m.id).sort()

/**
 * A synthetic module that declares no export and is NOT in
 * PROVISIONAL_RETENTION_PROFILES: what stays undecided (Q20's loud path), so the
 * refusal guards keep a module that is really unloaded.
 */
const UNDECIDED_ID = 'undecided_probe'
const votesEntry = catalogue.find((m) => m.id === 'votes')!
const undecidedProbe: LifecycleModule = { ...votesEntry, id: UNDECIDED_ID, moduleJson: { ...votesEntry.moduleJson, id: UNDECIDED_ID } }

describe('the platform on a fresh server', () => {
  let admin: Sql
  const pools: Sql[] = []
  const server: ModuleServer = {
    get admin() {
      return admin
    },
    open(database, options) {
      const sql = postgres(adminUrl(database), {
        max: 2,
        onnotice: () => {},
        ...(options?.role ? { connection: { options: `-c role=${options.role}` } } : {}),
      })
      pools.push(sql)
      return sql
    },
  }

  beforeAll(() => {
    admin = open('postgres', 2)
  })

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end({ timeout: 5 }).catch(() => {})))
    await admin.end({ timeout: 5 })
  })

  it('RED without init: there is no gremion_platform to enable against', async () => {
    const rows = await admin`SELECT 1 FROM pg_database WHERE datname = 'gremion_platform'`
    expect(rows.length).toBe(0)
    const p = open('gremion_platform', 1)
    let code: string | undefined
    try {
      await p`SELECT 1`
    } catch (err) {
      code = (err as { code?: string }).code
    } finally {
      await p.end({ timeout: 1 }).catch(() => {})
    }
    expect(code).toBe('3D000')
  })

  it('TDD 4: bootstrapPlatform creates, migrates and loads one module + one version row per decided module; a rerun changes nothing', async () => {
    const logs: string[] = []
    const r = await bootstrapPlatform({
      kernelAdmin: admin,
      openPlatform: () => open('gremion_platform', 2, OWNER, OWNER_PW),
      owner: OWNER,
      ownerPassword: OWNER_PW,
      releaseRef: 'dist-v0.0.1',
      catalogue,
      log: (l) => logs.push(l),
    })
    expect(r.platformCreated).toBe(true)
    // R31 O6: every platform migration file, derived from the directory (a later platform claim adds no line here)
    const platformFiles = readdirSync(join(REPO, 'packages/tenant-store/src/lifecycle/platform-migrations')).filter((f) => f.endsWith('.sql')).sort()
    expect(r.applied).toEqual(platformFiles)
    expect(r.applied).toEqual(expect.arrayContaining(['0001_plt_setup.sql', '0004_plt_provisioning_step.sql', '0005_plt_scheduled_job.sql']))
    // TASK-044: the ops setup, the isolation results and the DPIA decisions
    expect(r.applied).toEqual(expect.arrayContaining(['0006_ops_setup.sql', '0007_plt_isolation_test_result.sql', '0008_ops_dpia_decision.sql']))
    expect(r.applied).toContain('0009_plt_provisioning_request.sql') // TASK-043d-1
    expect(r.catalogue.insertedModules).toEqual(ALL_MODULES)
    expect(r.catalogue.insertedVersions).toEqual(r.catalogue.insertedModules)
    // R29-I24: the five database-less modules load under their provisional profiles; nothing is undecided
    expect(r.catalogue.undecided).toEqual([])
    expect(logs.filter((l) => l.includes('provisional retention profile')).sort()).toEqual([
      'catalogue: elections loaded with provisional retention profile rp-ele-module-data (R29-I24, pending the DPO)',
      'catalogue: files loaded with provisional retention profile rp-fil-module-data (R29-I24, pending the DPO)',
      'catalogue: handover loaded with provisional retention profile rp-hnd-module-data (R29-I24, pending the DPO)',
      'catalogue: messaging loaded with provisional retention profile rp-msg-module-data (R29-I24, pending the DPO)',
      'catalogue: votes loaded with provisional retention profile rp-gov-module-data (R29-I24, pending the DPO)',
    ])

    const p = open('gremion_platform', 1, OWNER, OWNER_PW)
    try {
      const rows = await p<{ module_key: string; ctx: string; semver: string; rp: string; status: string; ck: string; uk: string; n: number }[]>`
        SELECT m.module_key, m.owning_context_code AS ctx, v.semver, v.retention_profile_default_id AS rp, v.status,
               v.created_by_kind AS ck, v.updated_by_kind AS uk,
               (SELECT count(*)::int FROM plt.module_version x WHERE x.module_id = m.module_id) AS n
          FROM plt.module m JOIN plt.module_version v USING (module_id) ORDER BY 1`
      expect(rows.map((x) => x.module_key)).toEqual(ALL_MODULES)
      for (const x of rows) {
        const own = catalogue.find((m) => m.id === x.module_key)!
        expect(x).toMatchObject({ status: 'draft', ck: 'system', uk: 'system', n: 1, semver: own.moduleJson.runtime.version })
      }
      expect(rows.find((x) => x.module_key === 'calendar')).toMatchObject({ ctx: 'cal', rp: 'rp-cal-module-data' })
      expect(rows.find((x) => x.module_key === 'votes')).toMatchObject({ ctx: 'gov', rp: 'rp-gov-module-data' })
      expect(rows.find((x) => x.module_key === 'elections')).toMatchObject({ ctx: 'ele', rp: 'rp-ele-module-data' })
    } finally {
      await p.end()
    }

    const again = await bootstrapPlatform({
      kernelAdmin: admin,
      openPlatform: () => open('gremion_platform', 2, OWNER, OWNER_PW),
      owner: OWNER,
      ownerPassword: OWNER_PW,
      releaseRef: 'dist-v0.0.1',
      catalogue,
    })
    expect(again).toMatchObject({ platformCreated: false, applied: [] })
    expect(again.catalogue.insertedModules).toEqual([])
    expect(again.catalogue.insertedVersions).toEqual([])
  })

  it('a module that declares no export and is not in the provisional table stays undecided: no plt.module row, a loud log line (Q20 refusal path kept)', async () => {
    const logs: string[] = []
    const r = await bootstrapPlatform({
      kernelAdmin: admin,
      openPlatform: () => open('gremion_platform', 2, OWNER, OWNER_PW),
      owner: OWNER,
      ownerPassword: OWNER_PW,
      releaseRef: 'dist-v0.0.1',
      catalogue: [...catalogue, undecidedProbe],
      log: (l) => logs.push(l),
    })
    expect(r.catalogue.undecided.map((u) => u.moduleKey)).toEqual([UNDECIDED_ID])
    expect(r.catalogue.insertedModules).toEqual([])
    expect(logs.some((l) => l.startsWith(`catalogue: ${UNDECIDED_ID} NOT loaded:`))).toBe(true)
    const p = open('gremion_platform', 1, OWNER, OWNER_PW)
    try {
      expect((await p`SELECT 1 FROM plt.module WHERE module_key = ${UNDECIDED_ID}`).length).toBe(0)
    } finally {
      await p.end()
    }
  })

  // Review C MEDIUM #70 (r3 verifier): the pooled panel connected as the
  // control-DB owner and the gremion_platform owner. It only READS tenant,
  // tenant_domain and plt.provisioning_step (customers.ts), so `init` gives it
  // a LOGIN role that can do exactly that.
  it('ensurePanelReader: a LOGIN role that SELECTs tenant, tenant_domain and plt.provisioning_step, writes nothing, creates nothing; a rerun is a no-op', async () => {
    const CONTROL = 't043_control'
    const ROLE = 't043_panel'
    const PW = randomBytes(24).toString('base64url')
    if ((await admin`SELECT 1 FROM pg_database WHERE datname = ${CONTROL}`).length === 0) await admin.unsafe(`CREATE DATABASE ${CONTROL}`)
    const c = open(CONTROL, 1)
    try {
      await c.unsafe(`CREATE TABLE IF NOT EXISTS tenant (id uuid PRIMARY KEY, slug text NOT NULL);
                      CREATE TABLE IF NOT EXISTS tenant_domain (host text PRIMARY KEY, tenant_id uuid NOT NULL);
                      CREATE TABLE IF NOT EXISTS tenant_secret_ref (tenant_id uuid PRIMARY KEY, ref text)`)
    } finally {
      await c.end()
    }
    const deps = { kernelAdmin: admin, openAdminOn: (db: string) => open(db, 1), role: ROLE, password: PW, controlDatabase: CONTROL }
    expect(await ensurePanelReader(deps)).toEqual({ created: true })
    expect(await ensurePanelReader(deps)).toEqual({ created: false })

    const asPanelControl = open(CONTROL, 1, ROLE, PW)
    const asPanelPlatform = open('gremion_platform', 1, ROLE, PW)
    const code = async (q: Promise<unknown>) => q.then(() => 'ok', (e: { code?: string }) => e.code)
    try {
      expect(await code(asPanelControl`SELECT count(*) FROM tenant t LEFT JOIN tenant_domain d ON d.tenant_id = t.id`)).toBe('ok')
      expect(await code(asPanelPlatform`SELECT count(*) FROM plt.provisioning_step`)).toBe('ok')
      expect(await code(asPanelControl`INSERT INTO tenant (id, slug) VALUES (${randomUUID()}, 'x')`)).toBe('42501')
      expect(await code(asPanelControl`SELECT * FROM tenant_secret_ref`)).toBe('42501')
      expect(await code(asPanelControl.unsafe('CREATE TABLE panel_owned (x int)'))).toBe('42501')
      // TASK-043d: plt.module_enablement is in the read set now; the attestation table is not
      expect(await code(asPanelPlatform`SELECT count(*) FROM plt.operator_enable_attestation`)).toBe('42501')
      // DEFAULT VALUES: the privilege check runs before any constraint
      expect(await code(asPanelPlatform`INSERT INTO plt.provisioning_step DEFAULT VALUES`)).toBe('42501')
    } finally {
      await asPanelControl.end()
      await asPanelPlatform.end()
    }
    const [r] = await admin<{ s: boolean; c: boolean; r: boolean; b: boolean; l: boolean }[]>`
      SELECT rolsuper AS s, rolcreatedb AS c, rolcreaterole AS r, rolbypassrls AS b, rolcanlogin AS l FROM pg_roles WHERE rolname = ${ROLE}`
    expect(r).toEqual({ s: false, c: false, r: false, b: false, l: true })
  })

  // Review r4 LOW: `init` on a stack whose control registry is not migrated
  // yet failed with a bare 42P01; it names the missing table and the order.
  it('ensurePanelReader on an unmigrated control registry fails PRECONDITION naming the table and the migrate one-shot', async () => {
    const BARE = 't043_control_bare'
    if ((await admin`SELECT 1 FROM pg_database WHERE datname = ${BARE}`).length === 0) await admin.unsafe(`CREATE DATABASE ${BARE}`)
    const deps = { kernelAdmin: admin, openAdminOn: (db: string) => open(db, 1), role: 't043_panel_bare', password: randomBytes(24).toString('base64url'), controlDatabase: BARE }
    const err = await ensurePanelReader(deps).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toMatchObject({ code: 'PRECONDITION' })
    expect(String((err as Error).message)).toMatch(/public\.tenant.*t043_control_bare.*migrate/s)
  })

  it('pgLedger round-trips on 0004; pgGate records a written DPIA decision once and reports it', async () => {
    const p = open('gremion_platform', 2, OWNER, OWNER_PW)
    try {
      const ledger = pgLedger(p)
      const c = uuidv7()
      await ledger.append(c, 'realm_created', 'pending', OPERATOR)
      await ledger.append(c, 'realm_created', 'done', OPERATOR)
      let dup: unknown
      try {
        await ledger.append(c, 'realm_created', 'done', OPERATOR)
      } catch (err) {
        dup = err
      }
      expect(isDuplicateDone(dup)).toBe(true)
      expect((await ledger.rows(c)).map((r) => `${r.kind}=${r.status}`)).toEqual(['realm_created=pending', 'realm_created=done'])

      const gate = pgGate(p, { releaseTipSha: TIP })
      expect(await gate.hasDpiaDecision(c, 'calendar')).toBe(false)
      const first = await gate.recordDpia(c, 'calendar', DPIA, OPERATOR)
      expect(first.created).toBe(true)
      expect(await gate.recordDpia(c, 'calendar', DPIA, OPERATOR)).toEqual({ dpiaDecisionId: first.dpiaDecisionId, created: false })
      expect(await gate.hasDpiaDecision(c, 'calendar')).toBe(true)
      const rows = await p<{ id: string; by: string; kind: string }[]>`
        SELECT dpia_decision_id::text AS id, decided_by::text AS by, decided_by_kind AS kind FROM ops.dpia_decision WHERE customer_id = ${c}`
      expect(rows).toEqual([{ id: first.dpiaDecisionId, by: OPERATOR, kind: 'operator' }])
    } finally {
      await p.end()
    }
  })

  it('TDD 7 (TASK-044): calendar enables through the REAL gate with the imported pass and the recorded decision as its references; vault and publishing (no pass) are refused by EnableRefused with no database; a synthetic undecided module (Q20) is MODULE_VERSION_UNKNOWN; a moved tip makes the enabled modules unproven', async () => {
    const p = open('gremion_platform', 3, OWNER, OWNER_PW)
    try {
      const imported = await recordIsolationResults(p, evidence(['calendar', 'votes']))
      const passOf = (m: string) => imported.inserted.find((r) => r.module === m)!.isolationTestResultId
      const gate = pgGate(p, { releaseTipSha: TIP })
      const X = uuidv7()
      const ref = { id: X, slug: 'musterstadt', token: 'musterstadt', realm: 'musterstadt', host: 'rat.musterstadt.example' }
      const modules = pgModules({
        platform: p,
        catalogue: [...catalogue, undecidedProbe],
        lifecycle: {
          server: () => server,
          secrets: { appPassword: () => APP_PW },
          exporter: { dump: async () => {}, list: async () => '' },
          exportDir: resolve(REPO, '.scratch/t043/exports'),
          // TASK-075: the release every module-database ledger row records
          releaseRef: 'dist-v0.0.1',
          log: () => {},
        },
      })
      const before = (await admin<{ datname: string }[]>`SELECT datname FROM pg_database`).map((r) => r.datname)
      const decided: Record<string, string> = {}
      for (const m of ['calendar', 'vault', 'publishing', 'votes']) decided[m] = (await gate.recordDpia(X, m, DPIA, OPERATOR)).dpiaDecisionId
      expect((await modules.enable(ref, 'calendar', gate.enableGate, OPERATOR)).noop).toBe(false)
      // vault: no isolation case covers it (brief Q4), so the gate refuses it even with a decision
      // (and the deny list refuses it by name before the gate: operator-gate.test, customer.test)
      const vault = await modules.enable(ref, 'vault', gate.enableGate, OPERATOR).then(() => null, (e: unknown) => e)
      expect(vault).toBeInstanceOf(EnableRefused)
      expect(vault).toMatchObject({ code: 'NO_ISOLATION_RESULT', moduleKey: 'vault', customerId: X, tipSha: TIP })
      const hex = X.replaceAll('-', '')
      const after = (await admin<{ datname: string }[]>`SELECT datname FROM pg_database`).map((r) => r.datname)
      expect(after.filter((d) => !before.includes(d)).sort()).toEqual([`t_${hex}__calendar`])
      expect(await modules.enabled(ref)).toEqual(['calendar'])
      const rows = await p<{ module_key: string; iso: string; dpia: string; by_kind: string; by: string }[]>`
        SELECT m.module_key, e.isolation_test_result_id::text AS iso, e.dpia_decision_id::text AS dpia, e.enabled_by_kind AS by_kind, e.enabled_by::text AS by
          FROM plt.module_enablement e JOIN plt.module m USING (module_id) WHERE e.customer_id = ${X} ORDER BY 1`
      expect(rows).toEqual([{ module_key: 'calendar', iso: passOf('calendar'), dpia: decided.calendar, by_kind: 'operator', by: OPERATOR }])
      // a second enable is a no-op
      expect((await modules.enable(ref, 'calendar', gate.enableGate, OPERATOR)).noop).toBe(true)

      await expect(modules.enable(ref, 'publishing', gate.enableGate, OPERATOR)).rejects.toMatchObject({ code: 'NO_ISOLATION_RESULT' })
      expect((await admin`SELECT 1 FROM pg_database WHERE datname = ${`t_${hex}__publishing`}`).length).toBe(0)
      // the catalogue check runs before the gate
      let asked = false
      await expect(modules.enable(ref, UNDECIDED_ID, async () => ((asked = true), { isolationTestResultId: randomUUID(), dpiaDecisionId: randomUUID() }), OPERATOR)).rejects.toMatchObject({
        code: 'MODULE_VERSION_UNKNOWN',
      })
      expect(asked).toBe(false)
      // R29-I24: a database-less module with a provisional profile enables (no database created)
      const votes = await modules.enable(ref, 'votes', gate.enableGate, OPERATOR)
      expect(votes).toEqual({ noop: false, database: null })
      expect(await modules.enabled(ref)).toEqual(['calendar', 'votes'])
      expect(await gate.unproven(X)).toEqual([])
      // the next release: both enabled modules lack a pass on its tip (Q8)
      const next = pgGate(p, { releaseTipSha: 'f'.repeat(40) })
      expect((await next.unproven(X)).map((u) => [u.moduleKey, u.codes])).toEqual([
        ['calendar', ['ISOLATION_STALE_TIP']],
        ['votes', ['ISOLATION_STALE_TIP']],
      ])
    } finally {
      await p.end()
    }
  })
})
