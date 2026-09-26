// The runner's behaviour on a real Postgres 18: preApply under the lock
// (TDD 8), the Q4 out-of-order refusal (TDD 9), G-078 atomicity, the lock
// released on every exit path, and a no-op run executing no DDL.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { ADVISORY_LOCKS } from '../../src/advisory-locks.js'
import { tenantModuleDbName } from '../../src/names.js'
import { MigrationRunnerError, runMigrations, type PreApplyContext } from '../../src/runner.js'
import { openMigrationDb } from '../../src/store.js'
import { envResolveTarget } from '../../src/names.js'
import { assertNonProductionDbUrl, connect, ddlAttempts, ddlLog, ledgerFiles, resetWithProbe, serverUrl } from '../harness/db.js'
import { cleanupFixtures, copyFixture, FIXTURE_MIGRATIONS, writeManifest } from '../harness/migrations.js'

const quiet = { log: () => {} }
const DEFAULT_SESSION = { st: '0', sp: '"$user", public', role: 't020_test' }

/** The session state of EVERY connection of a 2-connection pool (both reserved at once). */
async function sessionStates(pool: ReturnType<typeof connect>) {
  const held = [await pool.reserve(), await pool.reserve()]
  try {
    const out = []
    for (const r of held) {
      const [x] = await r<{ st: string; sp: string; role: string }[]>`
        SELECT current_setting('statement_timeout') AS st, current_setting('search_path') AS sp, current_user AS role`
      out.push(x)
    }
    return out
  } finally {
    held.forEach((r) => r.release())
  }
}
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

  const ledger = () => ledgerFiles(watcher)
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
    const before = await ddlAttempts(watcher)
    expect(await runMigrations({ sql, dir: FIXTURE_MIGRATIONS, ...quiet })).toEqual({ applied: [], alreadyApplied: 3 })
    expect(await ddlAttempts(watcher)).toBe(before)
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
    const before = await ddlAttempts(watcher)
    await expect(runMigrations({ sql, dir, ...quiet })).rejects.toThrow(/unbalanced|transaction control/)
    expect(await ddlAttempts(watcher)).toBe(before)
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
      expect(await ddlAttempts(watcher)).toBe(0)
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
      const before = await ddlAttempts(watcher)
      const err = await rejection(runMigrations({ sql, dir: full, ...quiet }))
      expect(err?.code).toBe('OUT_OF_ORDER')
      expect(err?.files).toEqual(['002_item_state.sql', '003_item_state_idx.sql'])
      expect(err?.message).toMatch(/002_item_state\.sql, 003_item_state_idx\.sql/)
      expect(await ddlAttempts(watcher)).toBe(before)
      expect(await ledger()).toEqual(['001_init.sql', '005_later.sql'])
    })
  })

  describe('review round 1', () => {
    it('session state a body sets (SET ROLE, search_path, statement_timeout) is reset after its COMMIT', async () => {
      await watcher.unsafe('CREATE ROLE t020_other NOLOGIN').catch(() => {})
      const dir = copyFixture()
      writeFileSync(join(dir, '004_session.sql'), "SET statement_timeout = '1234ms';\nSET search_path = pg_catalog;\nSET ROLE t020_other;\n")
      writeManifest(dir)
      await runMigrations({ sql, dir, ...quiet })
      expect(await sessionStates(sql)).toEqual([DEFAULT_SESSION, DEFAULT_SESSION])
    })

    it('session state preApply set is reset too, when it throws', async () => {
      const err = await rejection(
        runMigrations({
          sql,
          dir: FIXTURE_MIGRATIONS,
          ...quiet,
          hooks: {
            async preApply(_f, ctx) {
              await ctx.sql.unsafe("SET search_path = pg_catalog; SET statement_timeout = '999ms'")
              throw new Error('no')
            },
          },
        }),
      )
      expect(err?.code).toBe('PRE_APPLY_FAILED')
      expect(await sessionStates(sql)).toEqual([DEFAULT_SESSION, DEFAULT_SESSION])
    })

    it('a pool of one connection is refused up front (the terminate path needs a second)', async () => {
      const one = connect(db, { max: 1 })
      try {
        await expect(runMigrations({ sql: one, dir: FIXTURE_MIGRATIONS, ...quiet })).rejects.toThrow(/at least 2 connections/)
        expect(await ddlAttempts(watcher)).toBe(0)
      } finally {
        await one.end()
      }
    })

    it('a body that releases the lock (pg_advisory_unlock_all) is rolled back, not committed', async () => {
      const dir = copyFixture()
      writeFileSync(join(dir, '004_unlock.sql'), 'CREATE TABLE sneaky (id int);\nSELECT pg_advisory_unlock_all();\n')
      writeManifest(dir)
      const lines: string[] = []
      const err = await rejection(runMigrations({ sql, dir, log: (l) => lines.push(l) }))
      expect(err?.code).toBe('LOCK_NOT_HELD')
      // the unlock then fails (the lock is gone): the backend is terminated, not handed back
      expect(lines.join('\n')).toMatch(/after the lock was already lost .* backend \d+ was terminated/)
      expect(await ledger()).toEqual(FILES)
      expect(await watcher`SELECT to_regclass('public.sneaky') AS r`).toEqual([{ r: null }])
      expect(await migrationLocks()).toEqual([])
    })

    it('a lock held elsewhere bounds the wait (LOCK_TIMEOUT), logs the holder, and executes no DDL', async () => {
      const holder = connect(db, { max: 1, connection: { application_name: 't020-holder' } })
      try {
        await holder`SELECT pg_advisory_lock(${ADVISORY_LOCKS.migration.classid}::int4, ${ADVISORY_LOCKS.migration.objid}::int4)`
        const lines: string[] = []
        const err = await rejection(runMigrations({ sql, dir: FIXTURE_MIGRATIONS, lockWaitTimeoutMs: 300, log: (l) => lines.push(l) }))
        expect(err?.code).toBe('LOCK_TIMEOUT')
        expect(lines.join('\n')).toMatch(/waiting for the migration lock \(held by pid \d+ 't020-holder'\)/)
        expect(await ddlAttempts(watcher)).toBe(0)
        // the lock_timeout used for the wait did not stay on the connection
        const [lt] = await sql<{ lt: string }[]>`SELECT current_setting('lock_timeout') AS lt`
        expect(lt!.lt).toBe('0')
      } finally {
        await holder.end()
      }
    })

    it('openMigrationDb gives the runner its direct connection (GREMION_<MODULE>_PG_DIRECT_URL)', async () => {
      const resolve = envResolveTarget({ GREMION_FIXTURE_PG_DIRECT_URL: serverUrl() }, 'direct')
      const direct = await openMigrationDb(A, 'fixture', {
        resolveTarget: (t, m) => {
          const target = resolve(t, m)
          assertNonProductionDbUrl(target.url)
          return target
        },
      })
      try {
        expect((await runMigrations({ sql: direct, dir: FIXTURE_MIGRATIONS, ...quiet })).applied).toEqual(FILES)
      } finally {
        await direct.end()
      }
    })
  })
})
