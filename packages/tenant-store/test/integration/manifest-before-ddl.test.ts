// TDD 3 — a tampered migration set fails the sha256 manifest check before ANY
// DDL, CREATE TABLE schema_migrations included (TRD-353 kept). The proof is a
// ddl_command_start event trigger (test/harness/db.ts resetWithProbe) that
// logs every DDL command; each spec ends with a positive control showing the
// probe does log, so "zero rows" is never vacuous.
import { appendFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { MigrationManifestError } from '../../src/manifest.js'
import { MigrationRunnerError, runMigrations } from '../../src/runner.js'
import { tenantModuleDbName } from '../../src/names.js'
import { connect, ddlAttempts, ddlLog, resetWithProbe } from '../harness/db.js'
import { cleanupFixtures, copyFixture, writeManifest } from '../harness/migrations.js'

const quiet = { log: () => {} }

describe('the whole manifest is checked before any DDL', () => {
  const { A } = inject('tenants')
  const db = tenantModuleDbName(A, 'fixture')
  let sql: ReturnType<typeof connect>

  beforeEach(async () => {
    await resetWithProbe(db)
    sql = connect(db)
    return async () => {
      await sql.end()
      cleanupFixtures()
    }
  })
  afterAll(() => resetWithProbe(db))

  async function ledgerPresent() {
    const [r] = await sql<{ present: boolean }[]>`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`
    return r!.present
  }

  /**
   * The positive control: the probe logs a committed CREATE TABLE, AND counts
   * one that is rolled back (the sequence), so "zero DDL" also rules out DDL
   * a runner ran inside a transaction and then rolled back.
   */
  async function expectProbeLive(before: number) {
    const attempts = await ddlAttempts(sql)
    await sql`CREATE TABLE public.t020_positive_control (x int)`
    expect((await ddlLog(sql)).length).toBe(before + 1)
    await sql.begin(async (tx) => {
      await tx`CREATE TABLE public.t020_rolled_back (x int)`
      throw new Error('rollback')
    }).catch(() => {})
    expect(await ddlAttempts(sql)).toBe(attempts + 2)
    expect((await ddlLog(sql)).length).toBe(before + 1)
  }

  async function problemCodes(p: Promise<unknown>) {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(MigrationManifestError)
    return (err as MigrationManifestError).problems.map((x) => `${x.code} ${x.file}`)
  }

  it('one changed byte in a pending file: the named error, zero DDL, no ledger table', async () => {
    const dir = copyFixture()
    appendFileSync(join(dir, '003_item_state_idx.sql'), ' ')
    expect(await problemCodes(runMigrations({ sql, dir, ...quiet }))).toEqual(['HASH_MISMATCH 003_item_state_idx.sql'])
    expect(await ddlLog(sql)).toEqual([])
    expect(await ddlAttempts(sql)).toBe(0)
    expect(await ledgerPresent()).toBe(false)
    await expectProbeLive(0)
  })

  it('a file with no manifest entry fails before any DDL', async () => {
    const dir = copyFixture()
    writeFileSync(join(dir, '004_extra.sql'), 'CREATE TABLE extra (id int);\n')
    expect(await problemCodes(runMigrations({ sql, dir, ...quiet }))).toEqual(['FILE_NOT_IN_MANIFEST 004_extra.sql'])
    expect(await ddlLog(sql)).toEqual([])
    expect(await ddlAttempts(sql)).toBe(0)
    await expectProbeLive(0)
  })

  it('a manifest entry with no file fails before any DDL', async () => {
    const dir = copyFixture()
    rmSync(join(dir, '003_item_state_idx.sql'))
    expect(await problemCodes(runMigrations({ sql, dir, ...quiet }))).toEqual(['MANIFEST_ENTRY_WITHOUT_FILE 003_item_state_idx.sql'])
    expect(await ddlLog(sql)).toEqual([])
    expect(await ddlAttempts(sql)).toBe(0)
    await expectProbeLive(0)
  })

  describe('an APPLIED file whose content changed after apply (CAP-BASE audit: applied files were skipped before their hash was checked)', () => {
    async function applyFirstTwo() {
      const r = await runMigrations({ sql, dir: copyFixture({ only: ['001_init.sql', '002_item_state.sql'] }), ...quiet })
      expect(r.applied).toEqual(['001_init.sql', '002_item_state.sql'])
      const logged = (await ddlLog(sql)).length
      // nothing was rolled back so far: every attempt is logged
      expect(await ddlAttempts(sql)).toBe(logged)
      return logged
    }

    it('manifest untouched: the manifest check fails on the applied file, zero new DDL, 003 not applied', async () => {
      const before = await applyFirstTwo()
      const dir = copyFixture()
      appendFileSync(join(dir, '001_init.sql'), '-- edited after apply\n')
      expect(await problemCodes(runMigrations({ sql, dir, ...quiet }))).toEqual(['HASH_MISMATCH 001_init.sql'])
      expect((await ddlLog(sql)).length).toBe(before)
      expect(await ddlAttempts(sql)).toBe(before)
      expect((await sql`SELECT filename FROM public.schema_migrations`).length).toBe(2)
      await expectProbeLive(before)
    })

    it('manifest regenerated to match: the LEDGER check fails on the applied file, zero new DDL, 003 not applied', async () => {
      const before = await applyFirstTwo()
      const dir = copyFixture()
      appendFileSync(join(dir, '001_init.sql'), '-- edited after apply\n')
      writeManifest(dir)
      const err = await runMigrations({ sql, dir, ...quiet }).then(
        () => undefined,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(MigrationRunnerError)
      expect((err as MigrationRunnerError).code).toBe('LEDGER_HASH_MISMATCH')
      expect((err as MigrationRunnerError).files).toEqual(['001_init.sql'])
      expect((await ddlLog(sql)).length).toBe(before)
      expect(await ddlAttempts(sql)).toBe(before)
      expect((await sql`SELECT filename FROM public.schema_migrations`).length).toBe(2)
      await expectProbeLive(before)
    })

    it('a ledger row whose file is gone fails before any DDL', async () => {
      const before = await applyFirstTwo()
      const dir = copyFixture()
      rmSync(join(dir, '001_init.sql'))
      writeManifest(dir)
      const err = await runMigrations({ sql, dir, ...quiet }).catch((e: unknown) => e)
      expect((err as MigrationRunnerError).code).toBe('LEDGER_UNKNOWN_FILE')
      expect((await ddlLog(sql)).length).toBe(before)
      expect(await ddlAttempts(sql)).toBe(before)
    })
  })
})
