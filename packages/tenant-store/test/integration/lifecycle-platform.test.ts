// TASK-043 TDD 2 and TDD 4 (tenant-store half) on the scratch stack:
//  - ensurePlatformDatabase creates gremion_platform on a server that has none
//    (the module server `pgm`: the harness never creates it there), owned by a
//    plain LOGIN role, PUBLIC unable to connect; a rerun is a no-op; a foreign
//    owner is refused; migratePlatform as that owner applies 0001-0004;
//  - plt.provisioning_step (0004) is append-only, done at most once per
//    (customer, kind), v7 ids only, eight kinds (7 and 8 appended, Q2);
//  - plt.operator_enable_attestation (Q19) is one row per (customer, module),
//    append-only.
import { randomBytes } from 'node:crypto'
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

  it('creates it owned by a plain LOGIN role, PUBLIC cannot connect, a rerun is a no-op, and migratePlatform as the owner applies 0001-0004', async () => {
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
      // TASK-075: every run names its release; the platform baseline phases the four files
      const m = await migratePlatform(owned, { releaseRef: 'dist-v0.0.1', log: () => {} })
      const files = [...loadManifest(PLATFORM_MIGRATIONS_DIR).keys()].sort()
      expect(m.applied.slice(0, 4)).toEqual(['0001_plt_setup.sql', '0002_plt_module.sql', '0003_plt_module_database.sql', '0004_plt_provisioning_step.sql'])
      expect(m.applied).toEqual(files)
      expect(m.applied).toEqual(expect.arrayContaining(['0005_ops_setup.sql', '0006_plt_isolation_test_result.sql', '0007_ops_dpia_decision.sql']))
      expect((await migratePlatform(owned, { releaseRef: 'dist-v0.0.1', log: () => {} })).applied).toEqual([])
      const ledger = await owned<{ filename: string; phase: string; release_ref: string }[]>`
        SELECT filename, phase, release_ref FROM public.schema_migrations ORDER BY filename`
      expect(ledger.map((r) => [r.phase, r.release_ref]).slice(0, 4)).toEqual([
        ['contract', 'dist-v0.0.1'],
        ['expand', 'dist-v0.0.1'],
        ['expand', 'dist-v0.0.1'],
        ['expand', 'dist-v0.0.1'],
      ])
      expect(ledger.every((r) => r.release_ref === 'dist-v0.0.1')).toBe(true)
      const tables = await owned<{ t: string; owner: string }[]>`
        SELECT schemaname || '.' || tablename AS t, tableowner AS owner FROM pg_tables WHERE schemaname IN ('plt', 'ops') ORDER BY 1`
      expect(tables.map((x) => x.t)).toEqual(expect.arrayContaining(['plt.module', 'plt.module_database', 'plt.module_enablement', 'plt.module_version', 'plt.operator_enable_attestation', 'plt.provisioning_step']))
      // TASK-044: the isolation results (plt) and the DPIA decisions (ops), owned by the platform owner like the rest
      expect(tables.map((x) => x.t)).toEqual(expect.arrayContaining(['plt.isolation_test_result', 'ops.dpia_decision']))
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
