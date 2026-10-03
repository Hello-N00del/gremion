// Q3 on a real PgBouncer (transaction pooling, test/harness/stack.mjs): the
// runner refuses it before taking any lock or executing any DDL; a runtime
// pool (openTenantDb, prepare:false) may use it.
import { afterAll, beforeEach, describe, expect, inject, it } from 'vitest'
import postgres from 'postgres'
import { ADVISORY_LOCKS } from '../../src/advisory-locks.js'
import { tenantModuleDbName } from '../../src/names.js'
import { MigrationRunnerError, runMigrations } from '../../src/runner.js'
import { createTenantStore } from '../../src/store.js'
import { connect, ddlAttempts, ledgerFiles, poolerUrl, resetWithProbe } from '../harness/db.js'
import { FIXTURE_MIGRATIONS, FIXTURE_RELEASE } from '../harness/migrations.js'

describe('Q3: PgBouncer in transaction mode', () => {
  const { A } = inject('tenants')
  const db = tenantModuleDbName(A, 'fixture')

  beforeEach(() => resetWithProbe(db))
  afterAll(() => resetWithProbe(db))

  it('SHOW pool_mode through the pooler answers 42704 like Postgres (why it is not the only signal)', async () => {
    const pooled = postgres(poolerUrl(db), { max: 1, prepare: false, onnotice: () => {} })
    try {
      await expect(pooled.unsafe('SHOW pool_mode')).rejects.toMatchObject({ code: '42704' })
    } finally {
      await pooled.end()
    }
  })

  it('the runner refuses the pooler: POOLER_TARGET, no lock taken, no DDL, no ledger', async () => {
    const pooled = postgres(poolerUrl(db), { max: 2, prepare: false, onnotice: () => {} })
    const watcher = connect(db, { max: 1 })
    try {
      const err = await runMigrations({ sql: pooled, dir: FIXTURE_MIGRATIONS, ...FIXTURE_RELEASE, log: () => {} }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(MigrationRunnerError)
      expect((err as MigrationRunnerError).code).toBe('POOLER_TARGET')
      expect(await ddlAttempts(watcher)).toBe(0)
      expect(await ledgerFiles(watcher)).toEqual([])
      const locks = await watcher`
        SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
           AND classid = ${ADVISORY_LOCKS.migration.classid}::oid AND objid = ${ADVISORY_LOCKS.migration.objid}::oid`
      expect(locks).toHaveLength(0)
    } finally {
      await pooled.end()
      await watcher.end()
    }
  })

  it('a runtime pool through the pooler works (prepare:false)', async () => {
    const store = createTenantStore({ resolveTarget: (t, m) => ({ url: poolerUrl(tenantModuleDbName(t, m)) }) })
    try {
      const sql = await store.openTenantDb(A, 'fixture')
      expect(await sql`SELECT current_database() AS d`).toEqual([{ d: db }])
    } finally {
      await store.close()
    }
  })
})
