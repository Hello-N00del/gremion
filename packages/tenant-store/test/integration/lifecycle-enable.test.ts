// TASK-021 TDD 6, 7, 11, 12 on the scratch stack: enabling lcfix for a
// customer creates and migrates exactly one database, owned by m_lcfix;
// a refused gate leaves nothing; the gate CHECK holds in the database; the
// app role of another module cannot connect; the lifecycle never opens the
// legacy control database. Post-conditions read from pg_database, pg_tables,
// the ledger and plt.*, never from a return value alone.
import type { Sql } from '@gremion/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { enableModule, LifecycleError, PLATFORM_MIGRATIONS_DIR } from '../../src/lifecycle/index.js'
import { PLATFORM_CHAIN } from '../../src/lifecycle/platform.js'
import { readVerifiedMigrations } from '../../src/manifest.js'
import { tenantModuleDbName } from '../../src/names.js'
import { pinnedPhaseFor, resolvePhase } from '../../src/phase.js'
import { PINNED_BASELINE } from '../../src/phase-baseline.js'
import { connect, connectModule, connectModuleAs } from '../harness/db.js'
import {
  APP_PASSWORD,
  databasesOn,
  lcfixModule,
  lifecycleDeps,
  moduleServer,
  OPERATOR,
  platformDb,
  resetModuleServer,
  seedCatalogue,
  uuidv7,
} from '../harness/lifecycle.js'

describe('enableModule on the scratch stack', () => {
  let platform: Sql
  let server: ReturnType<typeof moduleServer>

  beforeAll(async () => {
    platform = platformDb()
    server = moduleServer()
    await seedCatalogue(platform, 'lcfix')
    await resetModuleServer(server.admin, platform)
  })

  afterAll(async () => {
    await resetModuleServer(server.admin, platform)
    await server.close()
    await platform.end()
  })

  it('TDD 6: exactly one new pg_database row, migrated to the manifest, every table owned by m_lcfix; a second enable is a no-op', async () => {
    const X = uuidv7()
    const db = tenantModuleDbName(X, 'lcfix')
    const before = await databasesOn(server.admin)
    const r = await enableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
    const after = await databasesOn(server.admin)
    expect(after.filter((d) => !before.includes(d))).toEqual([db])
    expect(before.filter((d) => !after.includes(d))).toEqual([])
    expect(r).toMatchObject({ database: db, created: true, applied: ['001_init.sql', '002_item_customer_idx.sql'], noop: false })

    const owned = connectModule(db, { max: 1 })
    try {
      expect((await owned<{ filename: string }[]>`SELECT filename FROM public.schema_migrations ORDER BY 1`).map((x) => x.filename)).toEqual([
        '001_init.sql',
        '002_item_customer_idx.sql',
      ])
      const tables = await owned<{ tablename: string; tableowner: string }[]>`
        SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`
      expect(tables).toEqual([
        { tablename: 'audit', tableowner: 'm_lcfix' },
        { tablename: 'item', tableowner: 'm_lcfix' },
        { tablename: 'schema_migrations', tableowner: 'm_lcfix' },
      ])
      const [dbOwner] = await owned<{ owner: string }[]>`SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()`
      expect(dbOwner?.owner).toBe('m_lcfix')
    } finally {
      await owned.end()
    }
    const [row] = await platform<{ state: string; db_name: string }[]>`
      SELECT d.state, d.db_name FROM plt.module_database d JOIN plt.module m USING (module_id)
       WHERE d.customer_id = ${X} AND m.module_key = 'lcfix'`
    expect(row).toEqual({ state: 'enabled', db_name: db })
    const [en] = await platform<{ state: string; enabled: boolean; enabled_by: string; enabled_by_kind: string; has_refs: boolean }[]>`
      SELECT e.state, e.enabled, e.enabled_by::text, e.enabled_by_kind,
             (e.isolation_test_result_id IS NOT NULL AND e.dpia_decision_id IS NOT NULL AND e.enabled_at IS NOT NULL) AS has_refs
        FROM plt.module_enablement e JOIN plt.module m USING (module_id)
       WHERE e.customer_id = ${X} AND m.module_key = 'lcfix'`
    expect(en).toEqual({ state: 'enabled', enabled: true, enabled_by: OPERATOR.id, enabled_by_kind: 'operator', has_refs: true })

    // a second enable: nothing new on the server, nothing applied, noop
    const rowVersion = async () =>
      (
        await platform<{ rv: string }[]>`
          SELECT e.row_version::text AS rv FROM plt.module_enablement e JOIN plt.module m USING (module_id)
           WHERE e.customer_id = ${X} AND m.module_key = 'lcfix'`
      )[0]?.rv
    const rvBefore = await rowVersion()
    const again = await enableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
    expect(again).toMatchObject({ database: db, created: false, applied: [], noop: true })
    expect(await databasesOn(server.admin)).toEqual(after)
    expect(await rowVersion()).toBe(rvBefore)
    expect(rvBefore).toBe('1')
  })

  it('TDD 6: a crash injected after "enabling" leaves visible state; the next call resumes to enabled', async () => {
    const X = uuidv7()
    const db = tenantModuleDbName(X, 'lcfix')
    const crashing = lifecycleDeps(platform, server, {
      hooks: {
        afterStep: (step) => {
          if (step === 'enabling') throw new Error('injected crash after enabling')
        },
      },
    })
    await expect(enableModule(X, lcfixModule(), OPERATOR, crashing)).rejects.toThrow(/injected crash/)
    const [mid] = await platform<{ state: string }[]>`
      SELECT d.state FROM plt.module_database d JOIN plt.module m USING (module_id) WHERE d.customer_id = ${X} AND m.module_key = 'lcfix'`
    expect(mid?.state).toBe('enabling')
    expect(await databasesOn(server.admin)).not.toContain(db)

    // a crash after CREATE DATABASE, before the migrations
    const late = lifecycleDeps(platform, server, {
      hooks: {
        afterStep: (step) => {
          if (step === 'created') throw new Error('injected crash after create')
        },
      },
    })
    await expect(enableModule(X, lcfixModule(), OPERATOR, late)).rejects.toThrow(/injected crash after create/)
    expect(await databasesOn(server.admin)).toContain(db)

    const r = await enableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
    expect(r).toMatchObject({ database: db, created: false, applied: ['001_init.sql', '002_item_customer_idx.sql'] })
    const [done] = await platform<{ state: string }[]>`
      SELECT d.state FROM plt.module_database d JOIN plt.module m USING (module_id) WHERE d.customer_id = ${X} AND m.module_key = 'lcfix'`
    expect(done?.state).toBe('enabled')
  })

  it('TASK-075 G1b (TDD 13): migratePlatform and enable write release_ref/phase; a fresh-DB enable runs no dump hook, a resumed (existing) DB does', async () => {
    // migratePlatform (global setup, release dist-v0.0.1, the shipped baseline of chain platform):
    // one row per platform manifest file, each with the phase the default lookup resolves
    const phaseFor = pinnedPhaseFor(PLATFORM_CHAIN, PINNED_BASELINE)
    const expected = readVerifiedMigrations(PLATFORM_MIGRATIONS_DIR).map((f) => {
      const p = resolvePhase(f.file, f.text, phaseFor)
      return [f.file, p.phase, 'dist-v0.0.1', p.phase === 'contract' ? (p.contractAfter ?? null) : null]
    })
    const plt = await platform<{ filename: string; phase: string; release_ref: string; contract_after: string | null }[]>`
      SELECT filename, phase, release_ref, contract_after FROM public.schema_migrations ORDER BY filename`
    expect(plt.map((r) => [r.filename, r.phase, r.release_ref, r.contract_after])).toEqual(expected)
    expect(expected.slice(0, 2)).toEqual([
      ['0001_plt_setup.sql', 'contract', 'dist-v0.0.1', 'dist-v0.0.0'],
      ['0002_plt_module.sql', 'expand', 'dist-v0.0.1', null],
    ])

    const calls: string[] = []
    const upgradeHooks = { preApply: (file: string) => void calls.push(file) }
    // fresh: this enable creates the database -> nothing to lose, no hook
    const X = uuidv7()
    await enableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server, { releaseRef: 'dist-v2.0.0', upgradeHooks }))
    expect(calls).toEqual([])
    const owned = connectModule(tenantModuleDbName(X, 'lcfix'), { max: 1 })
    try {
      expect(await owned<{ phase: string; release_ref: string }[]>`SELECT DISTINCT phase, release_ref FROM public.schema_migrations`).toEqual([{ phase: 'expand', release_ref: 'dist-v2.0.0' }])
    } finally {
      await owned.end()
    }

    // an existing database (a crash after CREATE DATABASE, then the resumed call): the hook runs
    const Y = uuidv7()
    const late = lifecycleDeps(platform, server, { hooks: { afterStep: (step) => { if (step === 'created') throw new Error('injected crash after create') } } })
    await expect(enableModule(Y, lcfixModule(), OPERATOR, late)).rejects.toThrow(/injected crash after create/)
    await enableModule(Y, lcfixModule(), OPERATOR, lifecycleDeps(platform, server, { releaseRef: 'dist-v2.0.0', upgradeHooks }))
    expect(calls).toEqual(['001_init.sql', '002_item_customer_idx.sql'])
  })

  it('TDD 7a: enableGate -> null leaves no database and no enabled state', async () => {
    const X = uuidv7()
    const before = await databasesOn(server.admin)
    await expect(enableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server, { enableGate: () => null }))).rejects.toMatchObject({ code: 'GATE_REFUSED' })
    expect(await databasesOn(server.admin)).toEqual(before)
    const rows = await platform`
      SELECT 1 FROM plt.module_enablement WHERE customer_id = ${X} AND state = 'enabled'
      UNION ALL SELECT 1 FROM plt.module_database WHERE customer_id = ${X}`
    expect(rows.length).toBe(0)
  })

  it('TDD 7b: setting state=enabled with null gate references is refused by module_enablement_gate_check (23514)', async () => {
    const X = uuidv7()
    const [ids] = await platform<{ module_id: string; module_version_id: string }[]>`
      SELECT m.module_id::text, v.module_version_id::text FROM plt.module m JOIN plt.module_version v USING (module_id) WHERE m.module_key = 'lcfix'`
    await platform`
      INSERT INTO plt.module_enablement (customer_id, module_id, module_version_id, created_by_kind, updated_by_kind)
      VALUES (${X}, ${ids!.module_id}, ${ids!.module_version_id}, 'system', 'system')`
    let caught: { code?: string; constraint_name?: string } | undefined
    try {
      await platform`UPDATE plt.module_enablement SET state = 'enabled' WHERE customer_id = ${X}`
    } catch (err) {
      caught = err as { code?: string; constraint_name?: string }
    }
    expect(caught?.code).toBe('23514')
    expect(caught?.constraint_name).toBe('module_enablement_gate_check')
    await platform`DELETE FROM plt.module_enablement WHERE customer_id = ${X}`
  })

  it('an unregistered module version is refused before the gate and before any database', async () => {
    const X = uuidv7()
    const before = await databasesOn(server.admin)
    let gateCalled = false
    const deps = lifecycleDeps(platform, server, { enableGate: () => ((gateCalled = true), null) })
    await expect(enableModule(X, lcfixModule({ version: '9.9.9' }), OPERATOR, deps)).rejects.toMatchObject({ code: 'MODULE_VERSION_UNKNOWN' })
    expect(gateCalled).toBe(false)
    expect(await databasesOn(server.admin)).toEqual(before)
  })

  it('TDD 11: on the SAME server, another module\'s app role (NOSUPERUSER NOCREATEDB) cannot CONNECT; lcfix\'s own app role can', async () => {
    const X = uuidv7()
    const db = tenantModuleDbName(X, 'lcfix')
    await enableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
    const otherPassword = `other-${uuidv7()}`
    await server.admin.unsafe('DROP ROLE IF EXISTS m_other_app')
    const [q] = await server.admin<{ stmt: string }[]>`SELECT format('CREATE ROLE m_other_app LOGIN NOSUPERUSER NOCREATEDB PASSWORD %L', ${otherPassword}::text) AS stmt`
    await server.admin.unsafe(q!.stmt)
    try {
      const other = connectModuleAs(db, 'm_other_app', otherPassword)
      let denied: { code?: string } | undefined
      try {
        await other`SELECT 1`
      } catch (err) {
        denied = err as { code?: string }
      } finally {
        await other.end({ timeout: 1 }).catch(() => {})
      }
      expect(denied?.code).toBe('42501') // insufficient_privilege: permission denied for database
      // positive control: the module's own app role (SCRAM verifier set by the lifecycle) connects and has DML
      const own = connectModuleAs(db, 'm_lcfix_app', APP_PASSWORD)
      try {
        await own`INSERT INTO item (customer_id, note) VALUES (${X}, 'x')`
        expect((await own<{ n: number }[]>`SELECT count(*)::int AS n FROM item`)[0]?.n).toBe(1)
        const [attrs] = await own<{ super: boolean; bypass: boolean; createdb: boolean }[]>`
          SELECT rolsuper AS super, rolbypassrls AS bypass, rolcreatedb AS createdb FROM pg_roles WHERE rolname = current_user`
        expect(attrs).toEqual({ super: false, bypass: false, createdb: false })
        await expect(own`INSERT INTO schema_migrations (filename, sha256) VALUES ('999_x.sql', ${'0'.repeat(64)})`).rejects.toMatchObject({ code: '42501' })
      } finally {
        await own.end({ timeout: 1 })
      }
    } finally {
      await server.admin.unsafe('DROP ROLE IF EXISTS m_other_app')
    }
  })

  it('TDD 12: a legacy control ledger exists, and the lifecycle never opens control or any non-(tenant, module) database', async () => {
    const control = connect('control', { max: 1 })
    try {
      await control.unsafe('CREATE TABLE IF NOT EXISTS t021_legacy_ledger (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
      await control`INSERT INTO t021_legacy_ledger (filename) VALUES ('001_legacy.sql') ON CONFLICT DO NOTHING`
    } finally {
      await control.end()
    }
    const X = uuidv7()
    server.opened.length = 0
    await enableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
    expect(server.opened).toEqual([tenantModuleDbName(X, 'lcfix')])
    const [who] = await platform<{ db: string }[]>`SELECT current_database() AS db`
    expect(who?.db).toBe('gremion_platform')
    // and a platform handle that is NOT gremion_platform (e.g. control) is refused before anything runs
    const wrong = connect('control', { max: 2 })
    try {
      await expect(enableModule(uuidv7(), lcfixModule(), OPERATOR, lifecycleDeps(wrong, server))).rejects.toMatchObject({ code: 'NOT_PLATFORM' })
    } finally {
      await wrong.end()
    }
    expect(LifecycleError).toBeDefined()
  })
})
