// The runner's behaviour on a real Postgres 18: preApply under the lock
// (TDD 8), the Q4 out-of-order refusal (TDD 9), G-078 atomicity, the lock
// released on every exit path, and a no-op run executing no DDL.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { ADVISORY_LOCKS } from '../../src/advisory-locks.js'
import { tenantModuleDbName } from '../../src/names.js'
import { MigrationRunnerError, runMigrations, type PreApplyContext } from '../../src/runner.js'
import { connect, ddlLog, resetWithProbe } from '../harness/db.js'
import { cleanupFixtures, copyFixture, FIXTURE_MIGRATIONS, writeManifest } from '../harness/migrations.js'

const quiet = { log: () => {} }
const FILES = ['001_init.sql', '002_item_state.sql', '003_item_state_idx.sql']

describe('runMigrations on a real database', () => {
  const { A } = inject('tenants')
  const db = tenantModuleDbName(A, 'fixture')
  let sql: ReturnType<typeof connect>
  let watcher: ReturnType<typeof connect>

  beforeEach(async () => {
    await resetWithProbe(db)
    sql = connect(db)
    watcher = connect(db, { max: 1 })
    return async () => {
      await sql.end()
      await watcher.end()
      cleanupFixtures()
    }
  })
  afterAll(() => resetWithProbe(db))

  const ledger = async () =>
    (await watcher<{ filename: string }[]>`
      SELECT filename FROM public.schema_migrations ORDER BY filename`.catch(() => [])).map((r) => r.filename)
  const migrationLocks = () =>
    watcher<{ pid: number; granted: boolean }[]>`
      SELECT pid, granted FROM pg_locks
       WHERE locktype = 'advisory' AND classid = ${ADVISORY_LOCKS.migration.classid}::oid
         AND objid = ${ADVISORY_LOCKS.migration.objid}::oid AND objsubid = 2`
  const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as MigrationRunnerError)

  it('applies every file once, records its sha256, strips 001\'s wrapper, and releases the lock', async () => {
    const r = await runMigrations({ sql, dir: FIXTURE_MIGRATIONS, ...quiet })
    expect(r).toEqual({ applied: FILES, alreadyApplied: 0 })
    const rows = await watcher<{ filename: string; sha256: string }[]>`SELECT filename, sha256 FROM public.schema_migrations ORDER BY filename`
    expect(rows.map((x) => x.sha256)).toEqual(rows.map(() => expect.stringMatching(/^[0-9a-f]{64}$/)))
    expect(await watcher`SELECT 1 FROM pg_type WHERE typname = 'item_state'`).toHaveLength(1)
    expect(await migrationLocks()).toEqual([])
  })

  it('a second run with nothing pending executes no DDL at all (not even the ledger CREATE)', async () => {
    await runMigrations({ sql, dir: FIXTURE_MIGRATIONS, ...quiet })
    const before = (await ddlLog(watcher)).length
    expect(await runMigrations({ sql, dir: FIXTURE_MIGRATIONS, ...quiet })).toEqual({ applied: [], alreadyApplied: 3 })
    expect((await ddlLog(watcher)).length).toBe(before)
  })

  it('G-078: a failing file rolls back with its ledger row; earlier files stay; the lock is released', async () => {
    const dir = copyFixture()
    writeFileSync(join(dir, '004_broken.sql'), 'CREATE TABLE broken (id int);\nSELECT no_such_function();\n')
    writeManifest(dir)
    const err = await rejection(runMigrations({ sql, dir, ...quiet }))
    expect(err?.code).toBe('APPLY_FAILED')
    expect(err?.files).toEqual(['004_broken.sql'])
    expect(await ledger()).toEqual(FILES)
    expect(await watcher`SELECT to_regclass('public.broken') AS r`).toEqual([{ r: null }])
    expect(await migrationLocks()).toEqual([])
  })

  it('refuses a migration body whose top-level COMMIT would end the runner\'s transaction', async () => {
    const dir = copyFixture()
    writeFileSync(join(dir, '004_commit.sql'), 'CREATE TABLE c1 (id int);\nCOMMIT;\nCREATE TABLE c2 (id int);\n')
    writeManifest(dir)
    const before = (await ddlLog(watcher)).length
    await expect(runMigrations({ sql, dir, ...quiet })).rejects.toThrow(/unbalanced|transaction control/)
    expect((await ddlLog(watcher)).length).toBe(before)
  })

  describe('hooks.preApply (TASK-029, TASK-075)', () => {
    it('is called once per pending file, in order, under the lock, outside a transaction, after the previous file committed', async () => {
      const seen: { file: string; holder: boolean; inTx: boolean; ledger: string[]; ctx: Omit<PreApplyContext, 'sql'> }[] = []
      await runMigrations({
        sql,
        dir: copyFixture({ only: FILES.slice(0, 1) }),
        ...quiet,
      })
      await runMigrations({
        sql,
        dir: FIXTURE_MIGRATIONS,
        ...quiet,
        hooks: {
          async preApply(file, ctx) {
            const [me] = await ctx.sql<{ pid: number; tx: string | null }[]>`
              SELECT pg_backend_pid() AS pid, pg_current_xact_id_if_assigned()::text AS tx`
            const locks = await migrationLocks()
            seen.push({
              file,
              holder: locks.length === 1 && locks[0]!.granted && locks[0]!.pid === me!.pid,
              inTx: me!.tx !== null,
              ledger: await ledger(),
              ctx: { dir: ctx.dir, applied: ctx.applied, pending: ctx.pending },
            })
          },
        },
      })
      expect(seen.map((s) => s.file)).toEqual(['002_item_state.sql', '003_item_state_idx.sql'])
      expect(seen.every((s) => s.holder)).toBe(true)
      expect(seen.every((s) => !s.inTx)).toBe(true)
      expect(seen.map((s) => s.ledger)).toEqual([['001_init.sql'], ['001_init.sql', '002_item_state.sql']])
      expect(seen[0]!.ctx).toEqual({ dir: FIXTURE_MIGRATIONS, applied: ['001_init.sql'], pending: FILES.slice(1) })
    })

    it('throwing on the first pending file aborts the run: nothing applied, no DDL, lock released', async () => {
      const boom = new Error('bulk export not acknowledged')
      const err = await rejection(runMigrations({ sql, dir: FIXTURE_MIGRATIONS, ...quiet, hooks: { preApply: () => { throw boom } } }))
      expect(err?.code).toBe('PRE_APPLY_FAILED')
      expect(err?.cause).toBe(boom)
      expect(await ledger()).toEqual([])
      expect(await ddlLog(watcher)).toEqual([])
      expect(await migrationLocks()).toEqual([])
    })

    it('throwing on a later file applies nothing from that file on', async () => {
      const err = await rejection(
        runMigrations({
          sql,
          dir: FIXTURE_MIGRATIONS,
          ...quiet,
          hooks: { preApply: (f) => { if (f === '002_item_state.sql') throw new Error('no') } },
        }),
      )
      expect(err?.files).toEqual(['002_item_state.sql'])
      expect(await ledger()).toEqual(['001_init.sql'])
    })
  })

  describe('Q4: a pending file below the highest applied one is refused', () => {
    it('names the files and executes no DDL', async () => {
      // 003 needs 002's column, so the gap is made by applying 001 and a 005.
      const seed = copyFixture({ only: ['001_init.sql'] })
      writeFileSync(join(seed, '005_later.sql'), 'CREATE TABLE later (id int);\n')
      writeManifest(seed)
      await runMigrations({ sql, dir: seed, ...quiet })
      const full = copyFixture()
      writeFileSync(join(full, '005_later.sql'), 'CREATE TABLE later (id int);\n')
      writeManifest(full)
      const before = (await ddlLog(watcher)).length
      const err = await rejection(runMigrations({ sql, dir: full, ...quiet }))
      expect(err?.code).toBe('OUT_OF_ORDER')
      expect(err?.files).toEqual(['002_item_state.sql', '003_item_state_idx.sql'])
      expect(err?.message).toMatch(/002_item_state\.sql, 003_item_state_idx\.sql/)
      expect((await ddlLog(watcher)).length).toBe(before)
      expect(await ledger()).toEqual(['001_init.sql', '005_later.sql'])
    })
  })
})
