// CD module step, on the throwaway Postgres (a real server, real roles): the module step.
// A gate database is created through enableModule at an OLD chain of a fixture module, a later
// file is added to the chain, and upgradeModuleDatabases applies it as the owner m_<id>, with the
// release label of the new tag, and gives the app role the new objects. Post-conditions are read
// from the server (the ledger, pg_class privileges, a DDL probe), never from a return value alone.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Sql } from '@gremion/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { blockModuleDatabase, enableModule, upgradeModuleDatabases } from '../../src/lifecycle/index.js'
import type { LifecycleModule } from '../../src/lifecycle/index.js'
import { tenantModuleDbName } from '../../src/names.js'
import { connectModule, connectModuleAs } from '../harness/db.js'
import { writeManifest } from '../harness/migrations.js'
import { APP_PASSWORD, LCFIX_DIR, lcfixModule, lifecycleDeps, moduleServer, OPERATOR, platformDb, resetModuleServer, seedCatalogue, uuidv7 } from '../harness/lifecycle.js'

const OLD_RELEASE = 'dist-v0.0.1'
const NEW_RELEASE = 'dist-v0.0.2'
/** The fixture chain has no header and is in no baseline: every file is expand (as lifecycleDeps does). */
const expandOnly = () => () => ({ phase: 'expand' as const })

const made: string[] = []

/** A scratch module directory whose chain holds the first `files` of the lcfix fixture plus `extra`. */
function chain(files: string[], extra: Record<string, string> = {}): { module: LifecycleModule; add(name: string, sql: string): void } {
  const dir = mkdtempSync(join(tmpdir(), 'u6b-chain-'))
  made.push(dir)
  const mig = join(dir, 'migrations')
  mkdirSync(mig)
  for (const f of files) copyFileSync(join(LCFIX_DIR, 'migrations', f), join(mig, f))
  for (const [name, sql] of Object.entries(extra)) writeFileSync(join(mig, name), sql)
  writeManifest(mig)
  return {
    module: { ...lcfixModule(), dir },
    add(name, sql) {
      writeFileSync(join(mig, name), sql)
      writeManifest(mig)
    },
  }
}

describe('upgradeModuleDatabases on the scratch stack (module step)', () => {
  let platform: Sql
  let server: ReturnType<typeof moduleServer>

  beforeAll(async () => {
    platform = platformDb()
    server = moduleServer()
    await seedCatalogue(platform, 'lcfix')
    await resetModuleServer(server.admin, platform)
  })

  // every test is the only customer: the step upgrades EVERY enabled row against the module it is given
  beforeEach(async () => {
    await resetModuleServer(server.admin, platform)
  })

  afterAll(async () => {
    await resetModuleServer(server.admin, platform)
    await server.close()
    await platform.end()
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  const enableAtOldChain = async (module: LifecycleModule, tenant = uuidv7()) => {
    await enableModule(tenant, module, OPERATOR, lifecycleDeps(platform, server, { releaseRef: OLD_RELEASE }))
    return { tenant, db: tenantModuleDbName(tenant, 'lcfix') }
  }
  const upgrade = (module: LifecycleModule, srv = server, releaseRef = NEW_RELEASE) =>
    upgradeModuleDatabases({ platform, server: () => srv, catalogue: [module], releaseRef, phaseFor: expandOnly, log: () => {} })

  /** DDL command starts, seen on the database from now on (a ddl_command_start event trigger; rolled back ones count). */
  async function installProbe(db: string): Promise<() => Promise<number>> {
    const su = connectModule(db, { max: 1 })
    try {
      await su.unsafe(`
        CREATE SCHEMA t020_probe;
        CREATE SEQUENCE t020_probe.ddl_seq;
        CREATE FUNCTION t020_probe.log_ddl() RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN PERFORM nextval('t020_probe.ddl_seq'); END $$;
        CREATE EVENT TRIGGER t020_ddl_probe ON ddl_command_start EXECUTE FUNCTION t020_probe.log_ddl();`)
    } finally {
      await su.end()
    }
    return async () => {
      const s = connectModule(db, { max: 1 })
      try {
        const [r] = await s<{ n: string }[]>`SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS n FROM t020_probe.ddl_seq`
        return Number(r!.n)
      } finally {
        await s.end()
      }
    }
  }

  async function ledger(db: string) {
    const s = connectModule(db, { max: 1 })
    try {
      return await s<{ filename: string; phase: string; release_ref: string }[]>`SELECT filename, phase, release_ref FROM public.schema_migrations ORDER BY filename`
    } finally {
      await s.end()
    }
  }

  it('applies a new expand file as the owner with the new release label; the app role can use the new table; a second run applies nothing and runs no DDL', async () => {
    const c = chain(['001_init.sql', '002_item_customer_idx.sql'])
    const { db } = await enableAtOldChain(c.module)
    expect((await ledger(db)).map((r) => [r.filename, r.release_ref])).toEqual([
      ['001_init.sql', OLD_RELEASE],
      ['002_item_customer_idx.sql', OLD_RELEASE],
    ])

    c.add('003_note.sql', '-- lcfix 003\nCREATE TABLE note (note_id uuid PRIMARY KEY DEFAULT uuidv7(), body text NOT NULL);\n-- a schema of its own: no default privileges reach it, only the re-grant does\nCREATE SCHEMA extra;\nCREATE TABLE extra.thing (thing_id serial PRIMARY KEY, label text NOT NULL);\n')
    const ddlCount = await installProbe(db)
    const r = await upgrade(c.module)
    expect(r).toMatchObject({ total: 1, upgraded: 1, unchanged: 0, skipped: 0, failed: 0, files_applied: 1, failure: null })

    const rows = await ledger(db)
    expect(rows.map((x) => x.filename)).toEqual(['001_init.sql', '002_item_customer_idx.sql', '003_note.sql'])
    expect(rows[2]).toMatchObject({ phase: 'expand', release_ref: NEW_RELEASE })
    expect(rows[0]!.release_ref).toBe(OLD_RELEASE)

    // the owner created it, the app role may use it (the re-grant ran), and the ledger stays read-only for the app
    const su = connectModule(db, { max: 1 })
    try {
      const [t] = await su<{ owner: string }[]>`SELECT tableowner AS owner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'note'`
      expect(t?.owner).toBe('m_lcfix')
    } finally {
      await su.end()
    }
    const app = connectModuleAs(db, 'm_lcfix_app', APP_PASSWORD)
    try {
      await app`INSERT INTO note (body) VALUES ('hello')`
      await app`INSERT INTO extra.thing (label) VALUES ('hello')`
      expect((await app<{ n: number }[]>`SELECT count(*)::int AS n FROM extra.thing`)[0]?.n).toBe(1)
      expect((await app<{ n: number }[]>`SELECT count(*)::int AS n FROM note`)[0]?.n).toBe(1)
      await expect(app`INSERT INTO schema_migrations (filename, sha256, phase, release_ref) VALUES ('x', repeat('0', 64), 'expand', 'x')`).rejects.toMatchObject({ code: '42501' })
    } finally {
      await app.end()
    }

    // a second run: nothing pending, so no DDL command starts at all (the probe counts rolled back ones too)
    const before = await ddlCount()
    expect(before).toBeGreaterThan(0)
    const again = await upgrade(c.module)
    expect(again).toMatchObject({ total: 1, upgraded: 0, unchanged: 1, files_applied: 0, failed: 0, failure: null })
    expect(await ddlCount()).toBe(before)
    expect(await ledger(db)).toEqual(rows)
  })

  it('writes nothing to stdout or stderr by itself (the runner defaults to console.info): the step prints nothing, on success and on a failing file', async () => {
    const c = chain(['001_init.sql'])
    await enableAtOldChain(c.module)
    c.add('002_quiet.sql', '-- lcfix 002\nCREATE TABLE quiet_table (id int PRIMARY KEY);\n')
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'debug'),
      vi.spyOn(process.stdout, 'write'),
      vi.spyOn(process.stderr, 'write'),
    ]
    try {
      // no `log` given: the step's own default must be silent
      const ok = await upgradeModuleDatabases({ platform, server: () => server, catalogue: [c.module], releaseRef: NEW_RELEASE, phaseFor: expandOnly })
      expect(ok).toMatchObject({ upgraded: 1, failed: 0 })
      c.add('003_boom.sql', '-- lcfix 003\nSELECT 1 / 0;\n')
      const bad = await upgradeModuleDatabases({ platform, server: () => server, catalogue: [c.module], releaseRef: NEW_RELEASE, phaseFor: expandOnly })
      expect(bad).toMatchObject({ failed: 1, failure: { code: 'APPLY_FAILED' } })
      for (const spy of spies) expect(spy.mock.calls).toEqual([])
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  it('a ledger from before TASK-075 (no phase columns) is upgraded inside the first applied file\'s transaction', async () => {
    const c = chain(['001_init.sql', '002_item_customer_idx.sql'])
    const { db } = await enableAtOldChain(c.module)
    const su = connectModule(db, { max: 1 })
    try {
      // what a pre-TASK-075 runner wrote: (filename, sha256, applied_at) and nothing else
      await su.unsafe('ALTER TABLE public.schema_migrations DROP COLUMN phase, DROP COLUMN release_ref, DROP COLUMN contract_after')
      expect((await su<{ n: number }[]>`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'schema_migrations' AND column_name IN ('phase', 'release_ref', 'contract_after')`)[0]?.n).toBe(0)
    } finally {
      await su.end()
    }
    c.add('003_legacy.sql', '-- lcfix 003\nCREATE TABLE legacy_probe (id int PRIMARY KEY);\n')
    const r = await upgrade(c.module)
    expect(r).toMatchObject({ upgraded: 1, files_applied: 1, failed: 0, failure: null })
    const rows = await ledger(db)
    expect(rows.map((x) => [x.filename, x.phase, x.release_ref])).toEqual([
      ['001_init.sql', 'expand', 'pre-task-075'],
      ['002_item_customer_idx.sql', 'expand', 'pre-task-075'],
      ['003_legacy.sql', 'expand', NEW_RELEASE],
    ])
  })

  it('a failing third file leaves the files before it applied, rolls the failing one back, and the call reports a commit failure that names the file and no database', async () => {
    const c = chain(['001_init.sql'])
    const { db } = await enableAtOldChain(c.module)
    c.add('002_ok.sql', '-- lcfix 002\nCREATE TABLE ok_table (id int PRIMARY KEY);\n')
    c.add('003_bad.sql', '-- lcfix 003\nCREATE TABLE bad_table (id int PRIMARY KEY);\nSELECT 1 / 0;\n')
    const r = await upgrade(c.module)
    expect(r).toMatchObject({ total: 1, upgraded: 0, failed: 1, files_applied: 1, failure: { kind: 'commit', code: 'APPLY_FAILED', ordinal: 1, file: '003_bad.sql' } })
    expect((await ledger(db)).map((x) => x.filename)).toEqual(['001_init.sql', '002_ok.sql'])
    const su = connectModule(db, { max: 1 })
    try {
      const tables = (await su<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`).map((t) => t.tablename)
      expect(tables).toContain('ok_table')
      expect(tables).not.toContain('bad_table')
    } finally {
      await su.end()
    }
    expect(JSON.stringify(r)).not.toContain(db)
  })

  it('a blocked database is untouched: it is skipped, never opened, and its ledger and objects do not move', async () => {
    const c = chain(['001_init.sql'])
    const { tenant, db } = await enableAtOldChain(c.module)
    // what disableModule leaves: the app role cannot connect, plt.module_database says blocked (Karenz)
    await blockModuleDatabase(server.admin, db, tenant, 'lcfix', 'm_lcfix_app')
    await platform`UPDATE plt.module_database SET state = 'blocked', export_path = '/exports/x.dump', export_sha256 = repeat('a', 64), export_bytes = 1, exported_at = now() WHERE customer_id = ${tenant}`
    c.add('002_pending.sql', '-- lcfix 002\nCREATE TABLE pending_table (id int PRIMARY KEY);\n')
    const opened = server.opened.length
    const r = await upgrade(c.module)
    expect(server.opened.slice(opened)).not.toContain(db)
    expect(r).toMatchObject({ total: 1, skipped: 1, upgraded: 0, failed: 0, skippedByState: { blocked: 1 } })
    expect((await ledger(db)).map((x) => x.filename)).toEqual(['001_init.sql'])
    const su = connectModule(db, { max: 1 })
    try {
      expect((await su<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'pending_table'`)[0]?.n).toBe(0)
    } finally {
      await su.end()
    }
    await platform`UPDATE plt.module_database SET state = 'enabled' WHERE customer_id = ${tenant}`
  })

  it('two concurrent runs apply each file once (the advisory lock): the loser waits, then finds nothing pending', async () => {
    const c = chain(['001_init.sql'])
    const { db } = await enableAtOldChain(c.module)
    c.add('002_slow.sql', "-- lcfix 002\nCREATE TABLE slow_table (id int PRIMARY KEY);\nSELECT pg_sleep(1.5);\n")
    const second = moduleServer()
    try {
      const [a, b] = await Promise.all([upgrade(c.module, server), upgrade(c.module, second)])
      expect(a.files_applied + b.files_applied).toBe(1)
      expect([a.upgraded, b.upgraded].sort((x, y) => x - y)).toEqual([0, 1])
      expect([a.unchanged, b.unchanged].sort((x, y) => x - y)).toEqual([0, 1])
      expect(a.failure).toBeNull()
      expect(b.failure).toBeNull()
      expect((await ledger(db)).map((x) => x.filename)).toEqual(['001_init.sql', '002_slow.sql'])
    } finally {
      await second.close()
    }
  })

  it('a database that is enabled in plt but owned by a foreign role is refused, not migrated', async () => {
    const c = chain(['001_init.sql'])
    const { db } = await enableAtOldChain(c.module)
    await server.admin.unsafe(`ALTER DATABASE ${db} OWNER TO ${(await server.admin<{ u: string }[]>`SELECT current_user AS u`)[0]!.u}`)
    c.add('002_never.sql', '-- lcfix 002\nCREATE TABLE never_table (id int PRIMARY KEY);\n')
    const r = await upgrade(c.module)
    expect(r).toMatchObject({ failed: 1, failure: { kind: 'commit', code: 'DATABASE_FOREIGN_OWNER' } })
    expect((await ledger(db)).map((x) => x.filename)).toEqual(['001_init.sql'])
  })
})
