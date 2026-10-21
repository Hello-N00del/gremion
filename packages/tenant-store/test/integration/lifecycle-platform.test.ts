// TASK-043 TDD 2 and TDD 4 (tenant-store half) on the scratch stack:
//  - ensurePlatformDatabase creates gremion_platform on a server that has none
//    (the module server `pgm`: the harness never creates it there), owned by a
//    plain LOGIN role, PUBLIC unable to connect; a rerun is a no-op; a foreign
//    owner is refused; migratePlatform as that owner applies every manifest
//    file (0001-0005);
//  - plt.provisioning_step (0004) is append-only, done at most once per
//    (customer, kind), v7 ids only, eight kinds (7 and 8 appended, Q2);
//  - plt.operator_enable_attestation (Q19) is one row per (customer, module),
//    append-only.
import { createHash, randomBytes } from 'node:crypto'
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Sql } from '@gremion/db'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensurePlatformDatabase, migratePlatform, PLATFORM_DATABASE, PLATFORM_MIGRATIONS_DIR } from '../../src/lifecycle/index.js'
import type { LifecycleModule } from '../../src/lifecycle/index.js'
import { loadManifest } from '../../src/manifest.js'
import { tenantModuleDbName } from '../../src/names.js'
import { connectModule, moduleDbUrl } from '../harness/db.js'
import { lifecycleDeps, moduleServer, OPERATOR, platformDb, resetModuleServer, seedCatalogue, uuidv7 } from '../harness/lifecycle.js'

const OWNER = 't043_platform_owner'
const PASSWORD = randomBytes(24).toString('base64url')

function asOwner(db: string, max = 2): Sql {
  const u = new URL(moduleDbUrl(db))
  u.username = OWNER
  u.password = encodeURIComponent(PASSWORD)
  return postgres(u.toString(), { max, onnotice: () => {}, connect_timeout: 5 })
}

async function sqlError(p: Promise<unknown>): Promise<{ code?: string; constraint_name?: string } | undefined> {
  try {
    await p
  } catch (err) {
    return err as { code?: string; constraint_name?: string }
  }
  return undefined
}

describe('ensurePlatformDatabase on a server without gremion_platform (Q15)', () => {
  let admin: Sql

  beforeAll(async () => {
    admin = connectModule('postgres', { max: 1 })
    await admin.unsafe(`DROP DATABASE IF EXISTS ${PLATFORM_DATABASE} WITH (FORCE)`)
    await admin.unsafe(`DROP ROLE IF EXISTS ${OWNER}`)
  })

  afterAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${PLATFORM_DATABASE} WITH (FORCE)`)
    await admin.unsafe(`DROP ROLE IF EXISTS ${OWNER}`)
    await admin.unsafe('DROP ROLE IF EXISTS t043_intruder')
    await admin.end()
  })

  it('creates it owned by a plain LOGIN role, PUBLIC cannot connect, a rerun is a no-op, and migratePlatform as the owner applies every manifest file (0001-0005)', async () => {
    const before = (await admin<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname = ${PLATFORM_DATABASE}`).length
    expect(before).toBe(0)
    const r = await ensurePlatformDatabase(admin, { owner: OWNER, ownerPassword: PASSWORD })
    expect(r).toEqual({ owner: OWNER, created: true })
    const [role] = await admin<{ login: boolean; su: boolean; createdb: boolean; createrole: boolean; bypass: boolean }[]>`
      SELECT rolcanlogin AS login, rolsuper AS su, rolcreatedb AS createdb, rolcreaterole AS createrole, rolbypassrls AS bypass
        FROM pg_roles WHERE rolname = ${OWNER}`
    expect(role).toEqual({ login: true, su: false, createdb: false, createrole: false, bypass: false })
    const [db] = await admin<{ owner: string; public_connect: boolean }[]>`
      SELECT pg_get_userbyid(datdba) AS owner, has_database_privilege('public', datname, 'CONNECT') AS public_connect
        FROM pg_database WHERE datname = ${PLATFORM_DATABASE}`
    expect(db).toEqual({ owner: OWNER, public_connect: false })

    expect(await ensurePlatformDatabase(admin, { owner: OWNER, ownerPassword: PASSWORD })).toEqual({ owner: OWNER, created: false })

    const owned = asOwner(PLATFORM_DATABASE)
    try {
      // TASK-075: every run names its release; the platform baseline phases the headerless files.
      // R31 O6: the expected set is the manifest's keys (which the unit suite pins against the
      // directory), so a unit adding a platform file adds only a toContain line here.
      const files = [...loadManifest(PLATFORM_MIGRATIONS_DIR).keys()].sort()
      const m = await migratePlatform(owned, { releaseRef: 'dist-v0.0.1', log: () => {} })
      expect(m.applied).toEqual(files)
      expect(m.applied).toEqual(expect.arrayContaining(['0001_plt_setup.sql', '0004_plt_provisioning_step.sql']))
      expect(m.applied).toContain('0005_plt_scheduled_job.sql') // TASK-039-FU
      expect((await migratePlatform(owned, { releaseRef: 'dist-v0.0.1', log: () => {} })).applied).toEqual([])
      const ledger = await owned<{ filename: string; phase: string; release_ref: string }[]>`
        SELECT filename, phase, release_ref FROM public.schema_migrations ORDER BY filename`
      expect(ledger.map((r) => r.filename)).toEqual(files)
      expect(ledger.every((r) => r.release_ref === 'dist-v0.0.1')).toBe(true)
      // the phase per known file (0001 is the one pinned contract file); a future file adds a line here
      const phaseOf = (f: string) => ledger.find((r) => r.filename === f)?.phase
      expect(phaseOf('0001_plt_setup.sql')).toBe('contract')
      for (const f of ['0002_plt_module.sql', '0003_plt_module_database.sql', '0004_plt_provisioning_step.sql', '0005_plt_scheduled_job.sql']) {
        expect(phaseOf(f)).toBe('expand')
      }
      const tables = await owned<{ t: string; owner: string }[]>`
        SELECT tablename AS t, tableowner AS owner FROM pg_tables WHERE schemaname = 'plt' ORDER BY 1`
      // The EXACT table set: the eight tables of the five known files are listed
      // verbatim (a stray table added to one of them, or a table a file fails to
      // create, fails here), and a LATER file's tables are derived from its own
      // CREATE TABLE statements, so a unit that adds a platform file adds nothing
      // here (the same hot-spot rule as the file list above).
      const KNOWN_FILES = ['0001_plt_setup.sql', '0002_plt_module.sql', '0003_plt_module_database.sql', '0004_plt_provisioning_step.sql', '0005_plt_scheduled_job.sql']
      const KNOWN_TABLES = ['job_run', 'module', 'module_database', 'module_enablement', 'module_version', 'operator_enable_attestation', 'provisioning_step', 'scheduled_job']
      const laterTables = files
        .filter((f) => !KNOWN_FILES.includes(f))
        .flatMap((f) => [...readFileSync(join(PLATFORM_MIGRATIONS_DIR, f), 'utf8').matchAll(/^\s*CREATE TABLE(?:\s+IF NOT EXISTS)?\s+plt\.([a-z_]+)/gim)].map((x) => x[1]!))
      expect(tables.map((x) => x.t).sort()).toEqual([...KNOWN_TABLES, ...laterTables].sort())
      // TASK-044: the DPIA decisions live in schema ops (not in the plt-only set above), owned by the platform owner like the rest
      const opsTables = await owned<{ t: string; owner: string }[]>`
        SELECT tablename AS t, tableowner AS owner FROM pg_tables WHERE schemaname = 'ops' ORDER BY 1`
      expect(opsTables.map((x) => x.t)).toContain('dpia_decision')
      expect(new Set(opsTables.map((x) => x.owner))).toEqual(new Set([OWNER]))
      expect(new Set(tables.map((x) => x.owner))).toEqual(new Set([OWNER]))
    } finally {
      await owned.end()
    }
  })

  it('an intruding LOGIN role cannot connect to it', async () => {
    const pw = randomBytes(18).toString('base64url')
    await admin.unsafe('DROP ROLE IF EXISTS t043_intruder')
    const [q] = await admin<{ stmt: string }[]>`SELECT format('CREATE ROLE t043_intruder LOGIN PASSWORD %L', ${pw}::text) AS stmt`
    await admin.unsafe(q!.stmt)
    const u = new URL(moduleDbUrl(PLATFORM_DATABASE))
    u.username = 't043_intruder'
    u.password = encodeURIComponent(pw)
    const intruder = postgres(u.toString(), { max: 1, onnotice: () => {}, connect_timeout: 5 })
    try {
      expect((await sqlError(intruder`SELECT 1`))?.code).toBe('42501')
    } finally {
      await intruder.end({ timeout: 1 }).catch(() => {})
    }
  })

  it('refuses a gremion_platform owned by another role, and a role name that is not plain', async () => {
    await expect(ensurePlatformDatabase(admin, { owner: 't043_other_owner', ownerPassword: PASSWORD })).rejects.toMatchObject({ code: 'DATABASE_FOREIGN_OWNER' })
    // refused BEFORE any role is touched (review B1, r2): nothing was created
    expect((await admin`SELECT 1 FROM pg_roles WHERE rolname = 't043_other_owner'`).length).toBe(0)
    await admin.unsafe('DROP ROLE IF EXISTS t043_other_owner')
    // an existing role of another purpose is never demoted or re-passworded
    await admin.unsafe('DROP ROLE IF EXISTS t043_unrelated')
    await admin.unsafe('CREATE ROLE t043_unrelated NOLOGIN CREATEDB')
    try {
      await expect(ensurePlatformDatabase(admin, { owner: 't043_unrelated', ownerPassword: PASSWORD })).rejects.toMatchObject({ code: 'DATABASE_FOREIGN_OWNER' })
      const [r] = await admin<{ createdb: boolean; login: boolean }[]>`SELECT rolcreatedb AS createdb, rolcanlogin AS login FROM pg_roles WHERE rolname = 't043_unrelated'`
      expect(r).toEqual({ createdb: true, login: false })
    } finally {
      await admin.unsafe('DROP ROLE IF EXISTS t043_unrelated')
    }
    // the server's own admin role is never the platform owner
    const [me] = await admin<{ u: string }[]>`SELECT current_user AS u`
    // (when the admin IS postgres this repeats the 'postgres' case below; both refuse)
    await expect(ensurePlatformDatabase(admin, { owner: me!.u, ownerPassword: PASSWORD })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(ensurePlatformDatabase(admin, { owner: 'Bad-Name', ownerPassword: PASSWORD })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(ensurePlatformDatabase(admin, { owner: 'postgres', ownerPassword: PASSWORD })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})

describe('plt.provisioning_step (0004, TDD 2)', () => {
  let platform: Sql
  beforeAll(() => {
    platform = platformDb()
  })
  afterAll(async () => {
    await platform.end()
  })

  it('accepts all eight kinds, step_order 7 and 8 for the appended ones', async () => {
    const c = uuidv7()
    for (const k of ['realm_created', 'database_created', 'domain_bound', 'storage_prefix_reserved', 'first_body_created', 'first_accounts_created', 'broker_account_created', 'mail_principal_issued']) {
      await platform`INSERT INTO plt.provisioning_step (customer_id, step_kind, status) VALUES (${c}, ${k}, 'pending')`
    }
    const rows = await platform<{ step_kind: string; step_order: number }[]>`
      SELECT step_kind, step_order FROM plt.provisioning_step WHERE customer_id = ${c} ORDER BY step_order`
    expect(rows.map((r) => r.step_order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(rows.slice(6).map((r) => r.step_kind)).toEqual(['broker_account_created', 'mail_principal_issued'])
  })

  it('refuses UPDATE (append-only)', async () => {
    const c = uuidv7()
    await platform`INSERT INTO plt.provisioning_step (customer_id, step_kind, status) VALUES (${c}, 'realm_created', 'pending')`
    const err = await sqlError(platform`UPDATE plt.provisioning_step SET status = 'done' WHERE customer_id = ${c}`)
    expect(err?.code).toBe('23514')
  })

  // Review B1 MEDIUM (r2): a ledger that can be deleted or truncated is not
  // append-only; a resume would then re-run done steps.
  it('refuses DELETE and TRUNCATE (append-only); the row survives both', async () => {
    const c = uuidv7()
    await platform`INSERT INTO plt.provisioning_step (customer_id, step_kind, status) VALUES (${c}, 'realm_created', 'done')`
    expect(await sqlError(platform`DELETE FROM plt.provisioning_step WHERE customer_id = ${c}`)).toMatchObject({ code: '23514' })
    expect(await sqlError(platform`TRUNCATE plt.provisioning_step`)).toMatchObject({ code: '23514' })
    expect((await platform`SELECT 1 FROM plt.provisioning_step WHERE customer_id = ${c}`).length).toBe(1)
  })

  it('a second done of one kind is 23505 on provisioning_step_customer_id_step_kind_key; pending and failed may repeat', async () => {
    const c = uuidv7()
    for (const s of ['pending', 'failed', 'pending', 'done']) {
      await platform`INSERT INTO plt.provisioning_step (customer_id, step_kind, status) VALUES (${c}, 'domain_bound', ${s})`
    }
    const err = await sqlError(platform`INSERT INTO plt.provisioning_step (customer_id, step_kind, status) VALUES (${c}, 'domain_bound', 'done')`)
    expect(err).toMatchObject({ code: '23505', constraint_name: 'provisioning_step_customer_id_step_kind_key' })
  })

  it('a v4 id is 23514; an unknown kind or status is 23514', async () => {
    const c = uuidv7()
    const v4 = '8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'
    expect(await sqlError(platform`INSERT INTO plt.provisioning_step (provisioning_step_id, customer_id, step_kind, status) VALUES (${v4}, ${c}, 'realm_created', 'pending')`)).toMatchObject({
      code: '23514',
      constraint_name: 'provisioning_step_provisioning_step_id_check',
    })
    expect(await sqlError(platform`INSERT INTO plt.provisioning_step (customer_id, step_kind, status) VALUES (${c}, 'realm_deleted', 'pending')`)).toMatchObject({
      code: '23514',
      constraint_name: 'provisioning_step_step_kind_check',
    })
    expect(await sqlError(platform`INSERT INTO plt.provisioning_step (customer_id, step_kind, status) VALUES (${c}, 'realm_created', 'running')`)).toMatchObject({
      code: '23514',
      constraint_name: 'provisioning_step_status_check',
    })
  })
})

describe('plt.operator_enable_attestation (0004, Q19)', () => {
  let platform: Sql
  beforeAll(() => {
    platform = platformDb()
  })
  afterAll(async () => {
    await platform.end()
  })

  it('one row per (customer, module); append-only; the module must be in the enable list; the basis is fixed', async () => {
    const c = uuidv7()
    const op = '8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'
    const basis = 'interim gate, no isolation test (TASK-044)'
    await platform`INSERT INTO plt.operator_enable_attestation (customer_id, module_key, operator_id, enable_list, basis)
                   VALUES (${c}, 'calendar', ${op}, ${['calendar', 'vault']}, ${basis})`
    expect(
      await sqlError(platform`INSERT INTO plt.operator_enable_attestation (customer_id, module_key, operator_id, enable_list, basis)
                              VALUES (${c}, 'calendar', ${op}, ${['calendar']}, ${basis})`),
    ).toMatchObject({ code: '23505' })
    expect(await sqlError(platform`UPDATE plt.operator_enable_attestation SET operator_id = ${op} WHERE customer_id = ${c}`)).toMatchObject({ code: '23514' })
    expect(
      await sqlError(platform`INSERT INTO plt.operator_enable_attestation (customer_id, module_key, operator_id, enable_list, basis)
                              VALUES (${c}, 'vault', ${op}, ${['calendar']}, ${basis})`),
    ).toMatchObject({ code: '23514', constraint_name: 'operator_enable_attestation_enable_list_check' })
    expect(
      await sqlError(platform`INSERT INTO plt.operator_enable_attestation (customer_id, module_key, operator_id, enable_list, basis)
                              VALUES (${c}, 'vault', ${op}, ${['vault']}, 'because')`),
    ).toMatchObject({ code: '23514', constraint_name: 'operator_enable_attestation_basis_check' })
  })

  // Review B1 MEDIUM (r2): a deleted attestation would be re-minted with a
  // fresh id on resume, so the enablement's two references would change.
  it('refuses DELETE and TRUNCATE; the attestation id survives both', async () => {
    const c = uuidv7()
    const op = '8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'
    const [row] = await platform<{ id: string }[]>`
      INSERT INTO plt.operator_enable_attestation (customer_id, module_key, operator_id, enable_list, basis)
      VALUES (${c}, 'calendar', ${op}, ${['calendar']}, 'interim gate, no isolation test (TASK-044)') RETURNING attestation_id AS id`
    expect(await sqlError(platform`DELETE FROM plt.operator_enable_attestation WHERE customer_id = ${c}`)).toMatchObject({ code: '23514' })
    expect(await sqlError(platform`TRUNCATE plt.operator_enable_attestation`)).toMatchObject({ code: '23514' })
    const [still] = await platform<{ id: string }[]>`SELECT attestation_id AS id FROM plt.operator_enable_attestation WHERE customer_id = ${c}`
    expect(still?.id).toBe(row!.id)
  })
})

// TASK-039-FU (platform 0005): DB-PLT-SCHEDULED-JOB and DB-PLT-JOB-RUN verbatim
// from SCHEMA-gremion.md; one seeded definition, the weekly footprint measurement.
describe('plt.scheduled_job and plt.job_run (0005, TASK-039-FU)', () => {
  let platform: Sql
  const V4 = '8d6b9c7e-1f2a-4b3c-9d4e-5f6a7b8c9d0e'
  const created: string[] = []
  beforeAll(() => {
    platform = platformDb()
  })
  afterAll(async () => {
    for (const id of created) {
      await platform`DELETE FROM plt.job_run WHERE scheduled_job_id = ${id}`
      await platform`DELETE FROM plt.scheduled_job WHERE scheduled_job_id = ${id}`
    }
    await platform.end()
  })

  /** A customer-scope definition (its own made-up customer id), so the platform seed is untouched. */
  async function customerJob(kind = 'backup_nightly'): Promise<string> {
    const [r] = await platform<{ id: string }[]>`
      INSERT INTO plt.scheduled_job (scope, customer_id, job_kind, cron_expression, created_by_kind, updated_by_kind)
      VALUES ('customer', ${uuidv7()}, ${kind}, '0 2 * * *', 'system', 'system') RETURNING scheduled_job_id AS id`
    created.push(r!.id)
    return r!.id
  }

  it('seeds exactly one footprint_measurement definition (other units seed their own kinds): platform scope, cron 0 3 * * 1, enabled, system, row_version 1', async () => {
    const rows = await platform<Record<string, unknown>[]>`
      SELECT scope, customer_id, job_kind, cron_expression, enabled, created_by_kind, created_by, updated_by_kind, row_version::int AS row_version
        FROM plt.scheduled_job WHERE job_kind = 'footprint_measurement'`
    expect(rows).toEqual([
      {
        scope: 'platform',
        customer_id: null,
        job_kind: 'footprint_measurement',
        cron_expression: '0 3 * * 1',
        enabled: true,
        created_by_kind: 'system',
        created_by: null,
        updated_by_kind: 'system',
        row_version: 1,
      },
    ])
  })

  it('scheduled_job: a v4 id, a scope/customer mismatch, a bad job_kind, a four-field cron and a mismatched actor kind are 23514 on their own constraint', async () => {
    const ins = (over: Record<string, unknown>) => {
      const r = { id: null, scope: 'customer', customer: uuidv7(), kind: 'backup_nightly', cron: '0 2 * * *', ckind: 'system', cby: null, ...over }
      return platform`INSERT INTO plt.scheduled_job (scheduled_job_id, scope, customer_id, job_kind, cron_expression, created_by_kind, created_by, updated_by_kind)
        VALUES (coalesce(${r.id as string | null}::uuid, uuidv7()), ${r.scope as string}, ${r.customer as string | null}, ${r.kind as string}, ${r.cron as string}, ${r.ckind as string}, ${r.cby as string | null}, 'system')`
    }
    expect(await sqlError(ins({ id: V4 }))).toMatchObject({ code: '23514', constraint_name: 'scheduled_job_scheduled_job_id_check' })
    expect(await sqlError(ins({ scope: 'platform' }))).toMatchObject({ code: '23514', constraint_name: 'scheduled_job_scope_check' })
    expect(await sqlError(ins({ customer: null }))).toMatchObject({ code: '23514', constraint_name: 'scheduled_job_scope_check' })
    expect(await sqlError(ins({ scope: 'tenant' }))).toMatchObject({ code: '23514', constraint_name: 'scheduled_job_scope_check' })
    expect(await sqlError(ins({ kind: 'nightly_telepathy' }))).toMatchObject({ code: '23514', constraint_name: 'scheduled_job_job_kind_check' })
    expect(await sqlError(ins({ cron: '0 3 * *' }))).toMatchObject({ code: '23514', constraint_name: 'scheduled_job_cron_expression_check' })
    expect(await sqlError(ins({ cron: '0 3 * * * *' }))).toMatchObject({ code: '23514', constraint_name: 'scheduled_job_cron_expression_check' })
    expect(await sqlError(ins({ ckind: 'system', cby: V4 }))).toMatchObject({ code: '23514', constraint_name: 'scheduled_job_created_by_check' })
    expect(await sqlError(ins({ ckind: 'operator', cby: null }))).toMatchObject({ code: '23514', constraint_name: 'scheduled_job_created_by_check' })
  })

  it('scheduled_job: a second platform row for one job_kind is 23505 on scheduled_job_job_kind_customer_id_key (NULLS NOT DISTINCT)', async () => {
    const err = await sqlError(platform`
      INSERT INTO plt.scheduled_job (scope, job_kind, cron_expression, created_by_kind, updated_by_kind)
      VALUES ('platform', 'footprint_measurement', '0 3 * * 1', 'system', 'system')`)
    expect(err).toMatchObject({ code: '23505', constraint_name: 'scheduled_job_job_kind_customer_id_key' })
  })

  it('scheduled_job: an UPDATE goes through plt.touch_row (row_version + 1, updated_at bumped) and customer_id stays immutable (23514)', async () => {
    const id = await customerJob('dpia_reminder')
    const [before] = await platform<{ u: Date; v: number }[]>`SELECT updated_at AS u, row_version::int AS v FROM plt.scheduled_job WHERE scheduled_job_id = ${id}`
    await platform`UPDATE plt.scheduled_job SET enabled = false WHERE scheduled_job_id = ${id}`
    const [after] = await platform<{ u: Date; v: number; e: boolean }[]>`SELECT updated_at AS u, row_version::int AS v, enabled AS e FROM plt.scheduled_job WHERE scheduled_job_id = ${id}`
    expect(after!.e).toBe(false)
    expect(after!.v).toBe(before!.v + 1)
    expect(after!.u.getTime()).toBeGreaterThanOrEqual(before!.u.getTime())
    expect(await sqlError(platform`UPDATE plt.scheduled_job SET customer_id = ${uuidv7()} WHERE scheduled_job_id = ${id}`)).toMatchObject({ code: '23514' })
  })

  it('job_run: a v4 id, a scope/customer mismatch, a bad status, finished_at before started_at, and a missing started_at on a non-skipped run are 23514 on their own constraint', async () => {
    const job = await customerJob('purge_run')
    const cust = (await platform<{ c: string }[]>`SELECT customer_id AS c FROM plt.scheduled_job WHERE scheduled_job_id = ${job}`)[0]!.c
    let n = 0
    const run = (over: Record<string, unknown>) => {
      const r = { id: null, scope: 'customer', customer: cust, status: 'succeeded', started: '2026-10-05T03:00:00Z', finished: '2026-10-05T03:00:05Z', detail: 'footprint/2026-W41.json', ...over }
      return platform`INSERT INTO plt.job_run (job_run_id, scheduled_job_id, scope, customer_id, scheduled_for, started_at, finished_at, status, detail_ref)
        VALUES (coalesce(${r.id as string | null}::uuid, uuidv7()), ${job}, ${r.scope as string}, ${r.customer as string | null},
                '2026-10-05T03:00:00Z'::timestamptz + (${n++} * interval '1 week'), ${r.started as string | null}, ${r.finished as string}, ${r.status as string}, ${r.detail as string | null})`
    }
    expect(await sqlError(run({ id: V4 }))).toMatchObject({ code: '23514', constraint_name: 'job_run_job_run_id_check' })
    expect(await sqlError(run({ scope: 'platform' }))).toMatchObject({ code: '23514', constraint_name: 'job_run_scope_check' })
    expect(await sqlError(run({ customer: null }))).toMatchObject({ code: '23514', constraint_name: 'job_run_scope_check' })
    expect(await sqlError(run({ status: 'running' }))).toMatchObject({ code: '23514', constraint_name: 'job_run_status_check' })
    expect(await sqlError(run({ finished: '2026-10-05T02:59:59Z' }))).toMatchObject({ code: '23514', constraint_name: 'job_run_finished_at_check' })
    expect(await sqlError(run({ started: null }))).toMatchObject({ code: '23514', constraint_name: 'job_run_started_at_check' })
    // skipped may carry no started_at
    expect(await sqlError(run({ started: null, status: 'skipped' }))).toBeUndefined()
  })

  it('job_run: an empty or 501-character detail_ref is 23514; 500 characters and a null pointer are accepted', async () => {
    const job = await customerJob('restore_drill_due')
    const cust = (await platform<{ c: string }[]>`SELECT customer_id AS c FROM plt.scheduled_job WHERE scheduled_job_id = ${job}`)[0]!.c
    let n = 0
    const run = (detail: string | null) =>
      platform`INSERT INTO plt.job_run (scheduled_job_id, scope, customer_id, scheduled_for, started_at, finished_at, status, detail_ref)
        VALUES (${job}, 'customer', ${cust}, '2026-11-02T03:00:00Z'::timestamptz + (${n++} * interval '1 week'), now(), now(), 'succeeded', ${detail})`
    expect(await sqlError(run(''))).toMatchObject({ code: '23514', constraint_name: 'job_run_detail_ref_check' })
    expect(await sqlError(run('x'.repeat(501)))).toMatchObject({ code: '23514', constraint_name: 'job_run_detail_ref_check' })
    expect(await sqlError(run('x'.repeat(500)))).toBeUndefined()
    expect(await sqlError(run(null))).toBeUndefined()
  })

  it('job_run: one row per (job, scheduled_for) is 23505 on job_run_scheduled_job_id_scheduled_for_key; ON CONFLICT DO NOTHING makes the weekly write idempotent', async () => {
    const job = await customerJob('backup_nightly')
    const cust = (await platform<{ c: string }[]>`SELECT customer_id AS c FROM plt.scheduled_job WHERE scheduled_job_id = ${job}`)[0]!.c
    const ins = () => platform`INSERT INTO plt.job_run (scheduled_job_id, scope, customer_id, scheduled_for, started_at, finished_at, status, detail_ref)
      VALUES (${job}, 'customer', ${cust}, '2026-10-05T03:00:00Z', now(), now(), 'succeeded', 'a.json')`
    await ins()
    expect(await sqlError(ins())).toMatchObject({ code: '23505', constraint_name: 'job_run_scheduled_job_id_scheduled_for_key' })
    const again = await platform`INSERT INTO plt.job_run (scheduled_job_id, scope, customer_id, scheduled_for, started_at, finished_at, status, detail_ref)
      VALUES (${job}, 'customer', ${cust}, '2026-10-05T03:00:00Z', now(), now(), 'succeeded', 'b.json')
      ON CONFLICT (scheduled_job_id, scheduled_for) DO NOTHING RETURNING 1`
    expect(again.length).toBe(0)
  })

  it('job_run: an UPDATE is refused 23514 (job_run_append_only_trg) but a DELETE is allowed (the retention purge)', async () => {
    const job = await customerJob('backup_nightly')
    const cust = (await platform<{ c: string }[]>`SELECT customer_id AS c FROM plt.scheduled_job WHERE scheduled_job_id = ${job}`)[0]!.c
    await platform`INSERT INTO plt.job_run (scheduled_job_id, scope, customer_id, scheduled_for, started_at, finished_at, status, detail_ref)
      VALUES (${job}, 'customer', ${cust}, '2026-10-05T03:00:00Z', now(), now(), 'succeeded', 'a.json')`
    expect(await sqlError(platform`UPDATE plt.job_run SET status = 'failed' WHERE scheduled_job_id = ${job}`)).toMatchObject({ code: '23514' })
    expect((await platform`SELECT 1 FROM plt.job_run WHERE scheduled_job_id = ${job} AND status = 'succeeded'`).length).toBe(1)
    await platform`DELETE FROM plt.job_run WHERE scheduled_job_id = ${job}`
    expect((await platform`SELECT 1 FROM plt.job_run WHERE scheduled_job_id = ${job}`).length).toBe(0)
  })

  it('job_run: a run for a job that does not exist is 23503, and deleting a scheduled_job that has runs is 23001 (FK ON DELETE RESTRICT)', async () => {
    const job = await customerJob('backup_nightly')
    const cust = (await platform<{ c: string }[]>`SELECT customer_id AS c FROM plt.scheduled_job WHERE scheduled_job_id = ${job}`)[0]!.c
    expect(
      await sqlError(platform`INSERT INTO plt.job_run (scheduled_job_id, scope, customer_id, scheduled_for, started_at, finished_at, status)
        VALUES (${uuidv7()}, 'customer', ${cust}, now(), now(), now(), 'succeeded')`),
    ).toMatchObject({ code: '23503', constraint_name: 'job_run_scheduled_job_id_fkey' })
    await platform`INSERT INTO plt.job_run (scheduled_job_id, scope, customer_id, scheduled_for, started_at, finished_at, status, detail_ref)
      VALUES (${job}, 'customer', ${cust}, '2026-10-05T03:00:00Z', now(), now(), 'succeeded', 'a.json')`
    // ON DELETE RESTRICT (SCHEMA verbatim) raises restrict_violation 23001, not NO ACTION's 23503
    expect(await sqlError(platform`DELETE FROM plt.scheduled_job WHERE scheduled_job_id = ${job}`)).toMatchObject({ code: '23001', constraint_name: 'job_run_scheduled_job_id_fkey' })
  })

  it('the migration file declares its phase on line 1, sets lock_timeout, and the manifest/lock entry matches the bytes', () => {
    const file = '0005_plt_scheduled_job.sql'
    const text = readFileSync(join(PLATFORM_MIGRATIONS_DIR, file), 'utf8')
    expect(text.split('\n')[0]).toBe('-- gremion:phase expand')
    expect(text).toMatch(/^SET lock_timeout\b/m)
    const bytes = createHash('sha256').update(readFileSync(join(PLATFORM_MIGRATIONS_DIR, file))).digest('hex')
    expect(loadManifest(PLATFORM_MIGRATIONS_DIR).get(file)).toBe(bytes)
    // round 2: the lock half the title promises (a post-freeze edit with a
    // regenerated manifest used to pass here; register.mjs check alone caught it)
    const lock = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../scripts/migrations/applied.lock.json', import.meta.url)), 'utf8'))
    expect(lock.chains.platform.files[file]).toBe(bytes)
  })
})

// TASK-075 r2 (house review HIGH): `gremion-tenant init|create` runs from the
// gremion-ui/Dockerfile builder stage, which copies packages/* and each
// module's migrations, never scripts/. migratePlatform (init) and
// enableModule (phase B) must phase their headerless files from what ships
// in the package; a lookup that reads scripts/migrations/** from a kernel
// checkout finds nothing there and refuses every file PHASE_MISSING.
describe('TASK-075: the tenant-create image layout (no scripts/ in the tree)', () => {
  const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
  const ROOT = join(REPO, '.scratch', `t075-image-layout-${process.pid}`)
  const BOARD_OWNER = 't075_layout_owner'
  let admin: Sql
  let lc: typeof import('../../src/lifecycle/index.js')

  beforeAll(async () => {
    rmSync(ROOT, { recursive: true, force: true })
    // the Dockerfile's COPYs: the package sources, and module.json + migrations/ of a module
    cpSync(join(REPO, 'packages/tenant-store/src'), join(ROOT, 'packages/tenant-store/src'), { recursive: true, filter: (p) => !p.endsWith('.test.ts') })
    cpSync(join(REPO, 'modules/board/module.json'), join(ROOT, 'modules/board/module.json'))
    cpSync(join(REPO, 'modules/board/migrations'), join(ROOT, 'modules/board/migrations'), { recursive: true })
    if (existsSync(join(ROOT, 'scripts'))) throw new Error(`${ROOT} must not hold scripts/ (the image has none)`)
    lc =(await import(pathToFileURL(join(ROOT, 'packages/tenant-store/src/lifecycle/index.ts')).href)) as typeof import('../../src/lifecycle/index.js')
    admin = connectModule('postgres', { max: 1 })
    await admin.unsafe(`DROP DATABASE IF EXISTS ${PLATFORM_DATABASE} WITH (FORCE)`)
    await admin.unsafe(`DROP ROLE IF EXISTS ${BOARD_OWNER}`)
  })

  afterAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${PLATFORM_DATABASE} WITH (FORCE)`)
    await admin.unsafe(`DROP ROLE IF EXISTS ${BOARD_OWNER}`)
    await admin.end()
    rmSync(ROOT, { recursive: true, force: true })
  })

  it('migratePlatform (init) from the image layout applies every platform file with its phase', async () => {
    expect(lc.PLATFORM_MIGRATIONS_DIR.startsWith(ROOT)).toBe(true)
    await lc.ensurePlatformDatabase(admin, { owner: BOARD_OWNER, ownerPassword: PASSWORD })
    const u = new URL(moduleDbUrl(PLATFORM_DATABASE))
    u.username = BOARD_OWNER
    u.password = encodeURIComponent(PASSWORD)
    const owned = postgres(u.toString(), { max: 2, onnotice: () => {}, connect_timeout: 5 })
    try {
      const files = [...loadManifest(PLATFORM_MIGRATIONS_DIR).keys()].sort()
      const m = await lc.migratePlatform(owned, { releaseRef: 'dist-v0.0.1', log: () => {} })
      expect(m.applied).toEqual(files)
      const ledger = await owned<{ filename: string; phase: string }[]>`SELECT filename, phase FROM public.schema_migrations ORDER BY filename`
      expect(ledger.map((r) => r.filename)).toEqual(files)
      expect(ledger.every((r) => ['expand', 'migrate', 'contract'].includes(r.phase))).toBe(true)
    } finally {
      await owned.end()
    }
  })

  it('enableModule (phase B) from the image layout migrates a real module database with the default phase lookup', async () => {
    const platform = platformDb()
    const server = moduleServer()
    try {
      await seedCatalogue(platform, 'board')
      const moduleJson = JSON.parse(readFileSync(join(ROOT, 'modules/board/module.json'), 'utf8')) as LifecycleModule['moduleJson']
      const board: LifecycleModule = { id: 'board', dir: join(ROOT, 'modules/board'), moduleJson }
      // the harness default injects a phaseFor for the lcfix fixture; the image passes none
      const { phaseFor: _fixture, ...deps } = lifecycleDeps(platform, server, { server: () => server })
      const X = uuidv7()
      const r = await lc.enableModule(X, board, OPERATOR, deps)
      expect(r).toMatchObject({ database: tenantModuleDbName(X, 'board'), created: true, applied: ['001_init.sql'] })
      const owned = connectModule(tenantModuleDbName(X, 'board'), { max: 1 })
      try {
        expect(await owned<{ filename: string; phase: string; release_ref: string }[]>`SELECT filename, phase, release_ref FROM public.schema_migrations`).toEqual([
          { filename: '001_init.sql', phase: 'expand', release_ref: 'dist-v0.0.1' },
        ])
      } finally {
        await owned.end()
      }
    } finally {
      await resetModuleServer(server.admin, platform)
      await server.admin.unsafe('DROP ROLE IF EXISTS m_board_app')
      await server.admin.unsafe('DROP ROLE IF EXISTS m_board')
      await server.close()
      await platform.end()
    }
  })
})
