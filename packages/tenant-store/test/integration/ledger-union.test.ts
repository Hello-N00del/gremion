// TASK-077 G3 on a real Postgres 18 (brief TDD 8 and 17):
//   (a) `ledger`: a chain whose ledger lives in its own schema
//       (idt.schema_migration, SCHEMA §0.6) next to the legacy kernel runner's
//       public.schema_migrations(filename) -- the two never share a table;
//   (b) `dirs`: ONE manifest across several dirs, applied in NUMBER order, a
//       duplicate number refused before anything runs; TASK-029's
//       chainPreApply refuses a foreign ledger name in that ledger.
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, inject, it } from 'vitest'
import { chainPreApply } from '../../../../scripts/migrations/pre-apply.mjs'
import { tenantModuleDbName } from '../../src/names.js'
import { MigrationRunnerError, runMigrations } from '../../src/runner.js'
import { checkSchemaCurrent } from '../../src/schema-gate.js'
import { connect, ddlAttempts, resetWithProbe } from '../harness/db.js'
import { FIXTURE_MIGRATIONS, FIXTURE_RELEASE, writeManifest } from '../harness/migrations.js'

const quiet = { log: () => {}, ...FIXTURE_RELEASE }
const IDT = 'idt.schema_migration'

const made: string[] = []
/** A scratch dir holding exactly `files` of the fixture chain (manifest regenerated). */
function dirWith(files: string[], renames: Record<string, string> = {}): string {
  const d = mkdtempSync(join(tmpdir(), 't077-union-'))
  made.push(d)
  for (const f of files) cpSync(join(FIXTURE_MIGRATIONS, f), join(d, renames[f] ?? f))
  writeManifest(d)
  return d
}

describe('runMigrations ledger + dirs (TASK-077 G3)', () => {
  const { A } = inject('tenants')
  const db = tenantModuleDbName(A, 'fixture')
  let sql: ReturnType<typeof connect>
  let watcher: ReturnType<typeof connect>

  beforeEach(async () => {
    await resetWithProbe(db)
    const admin = connect(db, { max: 1 })
    await admin.unsafe('DROP SCHEMA IF EXISTS idt CASCADE')
    await admin.end()
    sql = connect(db)
    watcher = connect(db, { max: 1 })
    return async () => {
      await sql.end()
      await watcher.end()
      for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
    }
  })
  afterAll(async () => {
    await resetWithProbe(db)
    const admin = connect(db, { max: 1 })
    await admin.unsafe('DROP SCHEMA IF EXISTS idt CASCADE')
    await admin.end()
  })

  const rejection = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as MigrationRunnerError)
  const idtRows = () => watcher<{ filename: string; release_ref: string }[]>`SELECT filename, release_ref FROM idt.schema_migration ORDER BY applied_at, filename`

  it('TDD 8: beside the legacy public.schema_migrations(filename), the first run creates schema idt and lands in idt.schema_migration only', async () => {
    // The legacy kernel-data runner's ledger: filename only, no sha256 (db.ts).
    await watcher.unsafe("CREATE TABLE public.schema_migrations (filename text PRIMARY KEY); INSERT INTO public.schema_migrations VALUES ('0001_governance_schema.sql')")
    const r = await runMigrations({ sql, dir: FIXTURE_MIGRATIONS, ledger: IDT, ...quiet })
    expect(r.applied).toEqual(['001_init.sql', '002_item_state.sql', '003_item_state_idx.sql'])
    expect((await idtRows()).map((x) => x.filename)).toEqual(r.applied)
    // the legacy ledger is untouched: same single column, same single row
    expect(await watcher`SELECT filename FROM public.schema_migrations`).toEqual([{ filename: '0001_governance_schema.sql' }])
    const cols = await watcher<{ attname: string }[]>`
      SELECT attname FROM pg_attribute WHERE attrelid = 'public.schema_migrations'::regclass AND attnum > 0 AND NOT attisdropped`
    expect(cols.map((c) => c.attname)).toEqual(['filename'])
    // the gate reads the same ledger: current; the default ledger would be LEDGER_FORMAT territory
    expect((await checkSchemaCurrent({ sql: watcher, dir: FIXTURE_MIGRATIONS, ledger: IDT })).state).toBe('current')
    // a rerun applies nothing and runs no DDL
    const before = await ddlAttempts(watcher)
    expect(await runMigrations({ sql, dir: FIXTURE_MIGRATIONS, ledger: IDT, ...quiet })).toEqual({ applied: [], alreadyApplied: 3 })
    expect(await ddlAttempts(watcher)).toBe(before)
  })

  it('TDD 8 RED reference: the default ledger beside that legacy table is refused LEDGER_FORMAT (what an unmodified runner does)', async () => {
    await watcher.unsafe("CREATE TABLE public.schema_migrations (filename text PRIMARY KEY); INSERT INTO public.schema_migrations VALUES ('0001_governance_schema.sql')")
    const err = await rejection(runMigrations({ sql, dir: FIXTURE_MIGRATIONS, ...quiet }))
    expect(err?.code).toBe('LEDGER_FORMAT')
  })

  it('TDD 8: the ledger table carries the TASK-075 shape, its constraint names follow the table', async () => {
    await runMigrations({ sql, dir: FIXTURE_MIGRATIONS, ledger: IDT, ...quiet })
    await expect(watcher`INSERT INTO idt.schema_migration (filename, sha256, phase, release_ref) VALUES ('009_x.sql', ${'0'.repeat(64)}, 'contract', 'r')`).rejects.toMatchObject({
      code: '23514',
      constraint_name: 'schema_migration_contract_after_check',
    })
  })

  it('refuses an invalid ledger name before connecting anything', async () => {
    await expect(runMigrations({ sql, dir: FIXTURE_MIGRATIONS, ledger: 'idt.x; DROP TABLE y', ...quiet })).rejects.toThrow(/schema\.table/)
    await expect(runMigrations({ sql, dir: FIXTURE_MIGRATIONS, dirs: [FIXTURE_MIGRATIONS], ...quiet } as never)).rejects.toThrow(/exactly one of dir/)
  })

  it('TDD 17: interleaved numbers across two dirs apply in NUMBER order (001 a, 002 b, 003 a), one ledger', async () => {
    const a = dirWith(['001_init.sql', '003_item_state_idx.sql'])
    const b = dirWith(['002_item_state.sql'])
    const order: string[] = []
    const r = await runMigrations({ sql, dirs: [a, b], ledger: IDT, ...quiet, hooks: { preApply: (f, ctx) => void order.push(`${f}@${ctx.dirs?.length}:${ctx.ledger}`) } })
    // 003 creates an index on 002's column: a per-dir loop (a then b) would fail here
    expect(r.applied).toEqual(['001_init.sql', '002_item_state.sql', '003_item_state_idx.sql'])
    expect(order).toEqual(['001_init.sql@2:idt.schema_migration', '002_item_state.sql@2:idt.schema_migration', '003_item_state_idx.sql@2:idt.schema_migration'])
    expect((await idtRows()).map((x) => x.filename)).toEqual(r.applied)
    expect((await checkSchemaCurrent({ sql: watcher, dirs: [b, a], ledger: IDT })).state).toBe('current')
  })

  it('TDD 17: a migration number in two dirs is refused before any DDL (DUPLICATE_MIGRATION)', async () => {
    const a = dirWith(['001_init.sql', '002_item_state.sql'])
    const b = dirWith(['003_item_state_idx.sql'], { '003_item_state_idx.sql': '002_other.sql' })
    const before = await ddlAttempts(watcher)
    await expect(runMigrations({ sql, dirs: [a, b], ledger: IDT, ...quiet })).rejects.toThrow(/DUPLICATE_MIGRATION 002_other\.sql \(number 2 is also 002_item_state\.sql/)
    expect(await ddlAttempts(watcher)).toBe(before)
  })

  it("TDD 17: chainPreApply refuses a ledger row the chain lacks in idt.schema_migration (renamed applied file), nothing applied", async () => {
    const a = dirWith(['001_init.sql'])
    await runMigrations({ sql, dirs: [a], ledger: IDT, ...quiet })
    await watcher`UPDATE idt.schema_migration SET filename = '001_renamed.sql'`
    // the manifest would refuse first (LEDGER_UNKNOWN_FILE); give the run a dir that still has it, so the CHAIN check is what refuses
    const renamed = dirWith(['001_init.sql', '002_item_state.sql'], { '001_init.sql': '001_renamed.sql' })
    const err = await rejection(
      runMigrations({ sql, dirs: [renamed], ledger: IDT, ...quiet, hooks: { preApply: chainPreApply({ chainFiles: ['001_init.sql', '002_item_state.sql'] }) } }),
    )
    expect(err?.code).toBe('PRE_APPLY_FAILED')
    expect(String((err?.cause as Error)?.message)).toMatch(/LEDGER_NAME_NOT_IN_CHAIN/)
    expect((await idtRows()).map((x) => x.filename)).toEqual(['001_renamed.sql'])
  })

  it('the gate on a union: B one file behind is behind, the ledger unchanged by the check', async () => {
    const a = dirWith(['001_init.sql', '003_item_state_idx.sql'])
    const b = dirWith(['002_item_state.sql'])
    await runMigrations({ sql, dirs: [dirWith(['001_init.sql']), dirWith(['002_item_state.sql'])], ledger: IDT, ...quiet })
    const before = await idtRows()
    const status = await checkSchemaCurrent({ sql: watcher, dirs: [a, b], ledger: IDT })
    expect(status).toMatchObject({ state: 'behind', pending: ['003_item_state_idx.sql'] })
    expect(await idtRows()).toEqual(before)
  })

  it('writes nothing outside its ledger: no public.schema_migrations appears', async () => {
    await runMigrations({ sql, dir: FIXTURE_MIGRATIONS, ledger: IDT, ...quiet })
    expect(await watcher`SELECT to_regclass('public.schema_migrations') AS t`).toEqual([{ t: null }])
  })
})
