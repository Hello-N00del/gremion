// CD stage 1, unit U6g (enable-catchup) on the scratch stack, real roles and a real pg_dump: a module switched off
// (exported, blocked), a file added to its chain, the module switched on again. The enable dumps that ONE database
// before the file is applied (the dump parses with pg_restore --list), applies the file as the owner, gives the app
// role CONNECT back only after, commits, and only then retires the dump; the data is intact. A second switch-off and
// switch-on with nothing pending takes no dump. A failing file leaves the database blocked, the app role without
// CONNECT and the dump live. The dump hook and its exporter are bound to the module's own server (two real servers:
// the module server and the kernel server). The day-30 job retires a live dump of a database it drops, whatever
// release took it, and from the ROW after a crash. A failed release's live set refuses the switch-on by name.
// The real-uid half is enable-catchup-uid.test.ts. The no-database half is test/unit/enable-catchup.test.ts.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Sql } from '@gremion/db'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { catchupDump, pgDumpMajorOf, type CatchupDump } from '../../src/dump/catchup.js'
import { liveDumps, readEvents } from '../../src/dump/ledger.js'
import { retireDump } from '../../src/dump/retire.js'
import { defaultDumpFs, takeDump, type DumpFs } from '../../src/dump/take.js'
import { disableModule, enableModule, pgDumpExporter } from '../../src/lifecycle/index.js'
import { finalizeDueKarenz, type FinalizeDeps } from '../../src/lifecycle/karenz.js'
import type { Exporter, LifecycleDeps, LifecycleModule, ModuleServer } from '../../src/lifecycle/types.js'
import { tenantModuleDbName } from '../../src/names.js'
import { connect, dbUrl, stack } from '../harness/db.js'
import {
  APP_PASSWORD,
  databasesOn,
  EXPORT_ROOT,
  LCFIX_DIR,
  lcfixModule,
  lifecycleDeps,
  moduleServer,
  OPERATOR,
  platformDb,
  resetModuleServer,
  scratchExportStorage,
  seedCatalogue,
  uuidv7,
} from '../harness/lifecycle.js'

const DAY = 24 * 3600 * 1000
const RELEASE = 'dist-v1.2.3'
const MOD_SERVICE = 'lcfix-postgres' // runs on the harness module server `pgm`
const KERNEL_SERVICE = 'lcfk-postgres' // runs on the harness kernel server `pg`: a module whose server is not the module server

const moduleOn = (id: string, service: string): LifecycleModule => {
  const base = lcfixModule()
  return { ...base, id, moduleJson: { ...base.moduleJson, id, runtime: { ...base.moduleJson.runtime, database: { postgresService: service, migrations: 'migrations' } } } }
}
const lcfix = () => moduleOn('lcfix', MOD_SERVICE)
const lcfk = () => moduleOn('lcfk', KERNEL_SERVICE)

/** The dump dir checks need a POSIX uid; a Windows workstation has none, so it gets a fake 0700 stat of its own directory. */
const dumpFs = (): DumpFs => (typeof process.getuid === 'function' ? defaultDumpFs : { statDir: () => ({ isDirectory: true, mode: 0o700, uid: 1000 }), freeBytes: () => 10 ** 12, uid: 1000 })

const kernelContainer = () => (stack() as unknown as { kernelContainer?: string }).kernelContainer ?? `t020-${stack().sha8}-pg`

describe('the enable catch-up on the scratch stack', () => {
  let platform: Sql
  let server: ReturnType<typeof moduleServer>
  let kernelAdmin: Sql
  const kernelPools: Sql[] = []
  const scratch: string[] = []
  const audit: string[] = []

  const containerExporter = (container: string) =>
    pgDumpExporter({
      pgDump: ['docker', 'exec', '-i', container, 'pg_dump'],
      pgRestore: ['docker', 'exec', '-i', container, 'pg_restore'],
      connection: (t) => ({ args: ['-U', stack().user, '-d', t.database] }),
    })
  /** The exporter a lifecycle (and the dump hook) is handed: it resolves the container by the SERVICE of the target, as the live one resolves MODULE_PG_ADMIN_<ID>_FILE. */
  const exporterFor = (log?: { service: string; database: string }[]): Exporter => {
    const mod = containerExporter(stack().moduleContainer)
    const ker = containerExporter(kernelContainer())
    const by = (service: string) => {
      if (service === MOD_SERVICE) return mod
      if (service === KERNEL_SERVICE) return ker
      throw new Error(`no server for service ${JSON.stringify(service)}`)
    }
    return {
      dump: (t, file) => {
        log?.push({ service: t.service, database: t.database })
        return by(t.service).dump(t, file)
      },
      list: (file) => mod.list(file),
    }
  }

  const kernelServer = (): ModuleServer => ({
    admin: kernelAdmin,
    open(database, options) {
      const sql = connect(database, { max: 2, ...(options?.role ? { connection: { options: `-c role=${options.role}` } } : { connection: { search_path: 'pg_catalog' } }) })
      kernelPools.push(sql)
      return sql
    },
  })

  const deps = (c: CatchupDump | null, over: Partial<LifecycleDeps> = {}): LifecycleDeps =>
    lifecycleDeps(platform, server, {
      server: (service) => {
        if (service === MOD_SERVICE) return server
        if (service === KERNEL_SERVICE) return kernelServer()
        throw new Error(`no server for service ${JSON.stringify(service)}`)
      },
      exporter: exporterFor(),
      releaseRef: RELEASE,
      ...(c ? { upgradeHooks: c.upgradeHooks, dumpRetire: c.retire } : {}),
      ...over,
    })

  const freshDumpDir = (): string => {
    mkdirSync(EXPORT_ROOT, { recursive: true })
    const d = mkdtempSync(join(EXPORT_ROOT, 'u6g-dump-'))
    scratch.push(d)
    return d
  }
  const catchup = (dir: string, log?: { service: string; database: string }[], release = RELEASE) =>
    catchupDump({
      env: { GREMION_MIGRATION_DUMP_DIR: dir },
      release,
      exporter: exporterFor(log),
      pgUserFor: () => stack().user,
      // the dump tool is the server's own (this runner has no local pg_dump): the major of the one in the module server's container
      pgDumpMajor: async () => pgDumpMajorOf(execFileSync('docker', ['exec', stack().moduleContainer, 'pg_dump', '--version'], { encoding: 'utf8' })),
      fs: dumpFs(),
      audit: (l) => audit.push(l),
    })

  /** A copy of the module with one more migration (the release moved on while the module was off). */
  const withExtra = (base: LifecycleModule, file = '003_extra.sql', sql = '-- fixture 003 (added while the module was off)\nCREATE TABLE extra (extra_id uuid PRIMARY KEY DEFAULT uuidv7(), note text NOT NULL);\n'): LifecycleModule => {
    mkdirSync(EXPORT_ROOT, { recursive: true })
    const dir = mkdtempSync(join(EXPORT_ROOT, 'u6g-mod-'))
    scratch.push(dir)
    cpSync(LCFIX_DIR, dir, { recursive: true })
    writeFileSync(join(dir, 'migrations', file), sql)
    const manifestPath = join(dir, 'migrations', 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, string>
    manifest[file] = createHash('sha256').update(sql).digest('hex')
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    return { ...base, dir }
  }

  const owned = (sv: ModuleServer, db: string, role: string) => sv.open(db, { role }) as Sql
  const ownerQuery = async <T>(sv: ModuleServer, db: string, role: string, q: (sql: Sql) => Promise<T>): Promise<T> => {
    const sql = owned(sv, db, role)
    try {
      return await q(sql)
    } finally {
      await sql.end({ timeout: 5 })
    }
  }
  const appConnectCode = async (db: string, role: string, port: number): Promise<string | undefined> => {
    const u = new URL(dbUrl(db)) // host, user and the scratch ports are checked there; only the port and the login differ
    u.port = String(port)
    u.username = role
    u.password = encodeURIComponent(APP_PASSWORD)
    const own = postgres(u.toString(), { max: 1, onnotice: () => {}, connect_timeout: 5 })
    try {
      await own`SELECT 1`
      return undefined
    } catch (err) {
      return (err as { code?: string }).code
    } finally {
      await own.end({ timeout: 1 }).catch(() => {})
    }
  }

  /** An enabled tenant with a row of data on the given module, switched off (exported, blocked). */
  const blockedTenant = async (module: LifecycleModule, sv: ModuleServer) => {
    const X = uuidv7()
    const db = tenantModuleDbName(X, module.id)
    await enableModule(X, module, OPERATOR, deps(null, { releaseRef: 'dist-v0.0.1' }))
    await ownerQuery(sv, db, `m_${module.id}`, (sql) => sql`INSERT INTO item (customer_id, note) VALUES (${X}, 'kept through the Karenz')`)
    const r = await disableModule(X, module, OPERATOR, deps(null, { releaseRef: 'dist-v0.0.1' }))
    return { X, db, karenzId: r.karenz!.karenzId }
  }
  const stateOf = async (X: string, key: string) =>
    (await platform<{ state: string }[]>`SELECT d.state FROM plt.module_database d JOIN plt.module m USING (module_id) WHERE d.customer_id = ${X} AND m.module_key = ${key}`)[0]?.state
  const backdate = (karenzId: string) => platform`UPDATE plt.module_karenz SET switched_off_at = now() - interval '31 days', final_at = now() - interval '1 day' WHERE karenz_id = ${karenzId}`

  beforeAll(async () => {
    platform = platformDb()
    server = moduleServer()
    kernelAdmin = connect('postgres', { max: 2 })
    await seedCatalogue(platform, 'lcfix')
    await seedCatalogue(platform, 'lcfk')
    await resetModuleServer(server.admin, platform)
  })

  const dropKernelSide = async () => {
    for (const { datname } of await kernelAdmin<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname LIKE 't\\_%\\_\\_lcfk'`) {
      const [q] = await kernelAdmin<{ stmt: string }[]>`SELECT format('DROP DATABASE IF EXISTS %I WITH (FORCE)', ${datname}::text) AS stmt`
      await kernelAdmin.unsafe(q!.stmt)
    }
  }

  beforeEach(async () => {
    await resetModuleServer(server.admin, platform)
    await dropKernelSide()
    rmSync(lifecycleDeps(platform, server).exportDir, { recursive: true, force: true })
  })

  afterAll(async () => {
    await resetModuleServer(server.admin, platform)
    await dropKernelSide()
    await kernelAdmin.unsafe('DROP ROLE IF EXISTS m_lcfk').catch(() => {})
    await kernelAdmin.unsafe('DROP ROLE IF EXISTS m_lcfk_app').catch(() => {})
    await Promise.all(kernelPools.map((p) => p.end({ timeout: 5 }).catch(() => {})))
    await kernelAdmin.end({ timeout: 5 })
    await server.close()
    await platform.end()
    for (const d of scratch) rmSync(d, { recursive: true, force: true })
  })

  it('switch off, add a file, switch on: the dump exists while the file is applied and parses, the file is applied by the owner, CONNECT returns only after, the dump is retired, the data is intact', async () => {
    const { X, db } = await blockedTenant(lcfix(), server)
    const dir = freshDumpDir()
    const log: { service: string; database: string }[] = []
    const c = catchup(dir, log)
    const mod = withExtra(lcfix())
    const seen: { at: { live: number; fileExists: boolean; toc: string; appCode: string | undefined; extraBefore: boolean } | null } = { at: null }
    const hooks = (moduleId: string, service: string) => {
      const inner = c.upgradeHooks(moduleId, service)!
      return {
        preApply: async (file: string, ctx: Parameters<NonNullable<typeof inner.preApply>>[1]) => {
          await inner.preApply!(file, ctx)
          if (seen.at) return
          const live = liveDumps(readEvents(dir))
          const path = live[0] ? join(dir, live[0].file!) : ''
          const extra = await ctx.sql<{ r: string | null }[]>`SELECT to_regclass('public.extra')::text AS r`
          seen.at = {
            live: live.length,
            fileExists: path !== '' && existsSync(path),
            toc: path !== '' ? await exporterFor().list(path) : '',
            appCode: await appConnectCode(db, 'm_lcfix_app', stack().modulePort),
            extraBefore: extra[0]?.r !== null,
          }
        },
      }
    }

    expect(await appConnectCode(db, 'm_lcfix_app', stack().modulePort)).toBe('42501')
    const r = await enableModule(X, mod, OPERATOR, deps(c, { upgradeHooks: hooks }))

    expect(r).toMatchObject({ created: false, restored: true, noop: false, applied: ['003_extra.sql'] })
    // at the moment the file was about to be applied: one live dump, on disk, a real archive of THIS database with its data,
    // the app role still without CONNECT, the file not applied yet
    expect(seen.at).not.toBeNull()
    expect(seen.at!.live).toBe(1)
    expect(seen.at!.fileExists).toBe(true)
    expect(seen.at!.toc).toMatch(new RegExp(`^;\\s+dbname: ${db}$`, 'm'))
    expect(seen.at!.toc).toMatch(/TABLE DATA public item/)
    expect(seen.at!.appCode).toBe('42501')
    expect(seen.at!.extraBefore).toBe(false)
    // the exporter was bound to the module's own server
    expect(log).toEqual([{ service: MOD_SERVICE, database: db }])
    // the file was applied by the owner; the data is intact; the app role connects now
    expect(await ownerQuery(server, db, 'm_lcfix', (sql) => sql<{ owner: string }[]>`SELECT tableowner AS owner FROM pg_tables WHERE tablename = 'extra'`)).toEqual([{ owner: 'm_lcfix' }])
    expect(await ownerQuery(server, db, 'm_lcfix', (sql) => sql<{ n: number }[]>`SELECT count(*)::int AS n FROM item`)).toEqual([{ n: 1 }])
    expect((await ownerQuery(server, db, 'm_lcfix', (sql) => sql<{ filename: string }[]>`SELECT filename FROM public.schema_migrations ORDER BY 1`)).map((x) => x.filename)).toEqual(['001_init.sql', '002_item_customer_idx.sql', '003_extra.sql'])
    expect(await appConnectCode(db, 'm_lcfix_app', stack().modulePort)).toBeUndefined()
    expect(await stateOf(X, 'lcfix')).toBe('enabled')
    // retired after the commit: no live line, no file, a `deleted` line with the reason; nothing else in the directory
    const events = readEvents(dir)
    expect(events.filter((e) => e.event === 'created')).toMatchObject([{ release: RELEASE, database: db, scope: 'customer', module_id: 'lcfix', pg_service: MOD_SERVICE, pg_user: stack().user }])
    expect(liveDumps(events)).toEqual([])
    expect(events.filter((e) => e.event === 'deleted')).toMatchObject([{ database: db, reason: 'enable committed' }])
    expect(existsSync(join(dir, RELEASE))).toBe(false)
    // leak: the audit lines carry ids only (the database name is t_<hex32>__<module>, no slug)
    expect(audit.length).toBeGreaterThanOrEqual(2)
    for (const line of audit) expect(line).toMatch(/^premigration-dump (created|deleted) id=\S+ release=dist-v1\.2\.3 db=t_[0-9a-f]{32}__lcfix( sha256=[0-9a-f]{64} bytes=\d+)?( reason="[^"]+")?$/)

    // a second switch-off and switch-on with nothing pending takes no dump
    log.length = 0
    // the tenant side finishes the first restore (the Karenz row goes restoring -> restored), as the council app does
    await platform`UPDATE plt.module_karenz SET state = 'restored', restored_at = now() WHERE customer_id = ${X} AND state = 'restoring'`
    await disableModule(X, mod, OPERATOR, deps(null, { releaseRef: 'dist-v0.0.1' }))
    expect(await stateOf(X, 'lcfix')).toBe('blocked')
    const again = await enableModule(X, mod, OPERATOR, deps(c))
    expect(again).toMatchObject({ restored: true, applied: [] })
    expect(log).toEqual([])
    expect(readEvents(dir).filter((e) => e.event === 'created')).toHaveLength(1)
    expect(await stateOf(X, 'lcfix')).toBe('enabled')
  }, 120_000)

  it('a pending file that FAILS leaves the database blocked, the app role without CONNECT and the dump LIVE; the error reaches the caller', async () => {
    const { X, db } = await blockedTenant(lcfix(), server)
    const dir = freshDumpDir()
    const c = catchup(dir)
    const bad = withExtra(lcfix(), '003_bad.sql', '-- fixture 003: fails\nSELECT 1 / 0;\n')
    await expect(enableModule(X, bad, OPERATOR, deps(c))).rejects.toThrow()
    expect(await stateOf(X, 'lcfix')).toBe('blocked')
    expect(await appConnectCode(db, 'm_lcfix_app', stack().modulePort)).toBe('42501')
    const live = liveDumps(readEvents(dir))
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ release: RELEASE, database: db })
    expect(await exporterFor().list(join(dir, live[0]!.file!))).toMatch(new RegExp(`^;\\s+dbname: ${db}$`, 'm'))
    expect(await ownerQuery(server, db, 'm_lcfix', (sql) => sql<{ n: number }[]>`SELECT count(*)::int AS n FROM item`)).toEqual([{ n: 1 }])
    expect((await platform<{ state: string }[]>`SELECT state FROM plt.module_enablement e JOIN plt.module m USING (module_id) WHERE e.customer_id = ${X} AND m.module_key = 'lcfix'`)[0]?.state).toBe('disabled')
  }, 120_000)

  it('a module whose server is NOT the module server: the dump is taken on that server by its own service (a real exporter on two servers)', async () => {
    const { X, db } = await blockedTenant(lcfk(), kernelServer())
    expect(await databasesOn(kernelAdmin)).toContain(db)
    expect(await databasesOn(server.admin)).not.toContain(db)
    const dir = freshDumpDir()
    const log: { service: string; database: string }[] = []
    const c = catchup(dir, log)
    const mod = withExtra(lcfk())
    let toc = ''
    const hooks = (moduleId: string, service: string) => {
      const inner = c.upgradeHooks(moduleId, service)!
      return {
        preApply: async (file: string, ctx: Parameters<NonNullable<typeof inner.preApply>>[1]) => {
          await inner.preApply!(file, ctx)
          const live = liveDumps(readEvents(dir))
          if (live[0] && !toc) toc = await exporterFor().list(join(dir, live[0].file!))
        },
      }
    }
    const r = await enableModule(X, mod, OPERATOR, deps(c, { upgradeHooks: hooks }))
    expect(r.applied).toEqual(['003_extra.sql'])
    expect(log).toEqual([{ service: KERNEL_SERVICE, database: db }])
    expect(toc).toMatch(new RegExp(`^;\\s+dbname: ${db}$`, 'm'))
    expect(readEvents(dir).filter((e) => e.event === 'created')).toMatchObject([{ database: db, pg_service: KERNEL_SERVICE, pg_user: stack().user }])
    expect(liveDumps(readEvents(dir))).toEqual([])
    expect(await stateOf(X, 'lcfk')).toBe('enabled')
  }, 120_000)

  describe('the day-30 job retires a live dump of a database it drops', () => {
    const due = async (bad: LifecycleModule) => {
      const t = await blockedTenant(lcfix(), server)
      await backdate(t.karenzId)
      const dir = freshDumpDir()
      const c = catchup(dir)
      await expect(enableModule(t.X, bad, OPERATOR, deps(c))).rejects.toThrow() // the failed catch-up: the dump stays live, the database blocked
      expect(liveDumps(readEvents(dir))).toHaveLength(1)
      return { ...t, dir }
    }
    const finDeps = (over: Partial<FinalizeDeps> = {}): FinalizeDeps => ({
      platform,
      server: () => server,
      catalogue: [lcfix()],
      exportDir: lifecycleDeps(platform, server).exportDir,
      exportStorage: scratchExportStorage(lifecycleDeps(platform, server).exportDir),
      finalDeletion: true,
      now: () => new Date(Date.now() + 40 * DAY),
      ...over,
    })
    const nextTake = (dir: string, db: string, X: string) =>
      takeDump({
        dir,
        release: 'dist-vNEXT',
        database: db,
        scope: 'customer',
        customerId: X,
        moduleId: 'lcfix',
        exporter: { dump: async (_t, file) => void writeFileSync(file, 'PGDMP fake', { flag: 'wx', mode: 0o600 }), list: async () => `;\n; Archive created at 2026-11-17 03:00:00 UTC\n;     dbname: ${db}\n` },
        probe: { serverMajor: async () => 18, pgDumpMajor: async () => 18, databaseBytes: async () => 1000 },
        fs: dumpFs(),
        audit: () => {},
      })

    it('after a failed catch-up the dump is live; the job drops the blocked database (under ANOTHER release label); the dump is retired and a host-style take of another label succeeds', async () => {
      const t = await due(withExtra(lcfix(), '003_bad.sql', '-- fixture 003: fails\nSELECT 1 / 0;\n'))
      await expect(nextTake(t.dir, t.db, t.X)).rejects.toMatchObject({ code: 'DUMP_SERIES' })
      const later = catchup(t.dir, undefined, 'dist-vLATER')
      const r = await finalizeDueKarenz(finDeps({ afterDrop: (_t, _m, db) => later.retire.afterDrop(db) }))
      expect(r.errors).toEqual([])
      expect(await databasesOn(server.admin)).not.toContain(t.db)
      expect(await stateOf(t.X, 'lcfix')).toBe('dropped')
      expect(liveDumps(readEvents(t.dir))).toEqual([])
      expect(readEvents(t.dir).filter((e) => e.event === 'deleted')).toMatchObject([{ release: RELEASE, database: t.db, reason: 'database dropped by Karenz' }])
      expect(existsSync(join(t.dir, RELEASE))).toBe(false)
      expect((await nextTake(t.dir, t.db, t.X)).status).toBe('created')
    }, 120_000)

    it('without the afterDrop call the dump outlives its database and still refuses the next take (the guard)', async () => {
      const t = await due(withExtra(lcfix(), '003_bad.sql', '-- fixture 003: fails\nSELECT 1 / 0;\n'))
      const r = await finalizeDueKarenz(finDeps())
      expect(r.errors).toEqual([])
      expect(await databasesOn(server.admin)).not.toContain(t.db)
      expect(liveDumps(readEvents(t.dir))).toHaveLength(1)
      await expect(nextTake(t.dir, t.db, t.X)).rejects.toMatchObject({ code: 'DUMP_SERIES' })
    }, 120_000)

    it('the crash case: a throw at cas-dropped (before afterDrop), then a second run: the row is finalizing with the database row dropped, afterDrop runs FROM THE ROW and the dump is retired', async () => {
      const t = await due(withExtra(lcfix(), '003_bad.sql', '-- fixture 003: fails\nSELECT 1 / 0;\n'))
      const later = catchup(t.dir, undefined, 'dist-vLATER')
      let crash = true
      const common = {
        afterDrop: (_t: string, _m: string, db: string) => later.retire.afterDrop(db),
        hooks: {
          afterStep: (step: string) => {
            if (step === 'cas-dropped' && crash) throw new Error('the process died after the state write')
          },
        },
      }
      const first = await finalizeDueKarenz(finDeps(common as Partial<FinalizeDeps>))
      expect(first.errors).toHaveLength(1)
      expect(await stateOf(t.X, 'lcfix')).toBe('dropped')
      expect(liveDumps(readEvents(t.dir))).toHaveLength(1)
      crash = false
      const second = await finalizeDueKarenz(finDeps(common as Partial<FinalizeDeps>))
      expect(second.errors).toEqual([])
      expect(liveDumps(readEvents(t.dir))).toEqual([])
      expect((await nextTake(t.dir, t.db, t.X)).status).toBe('created')
    }, 120_000)
  })

  it('F65 case b: a failed release leaves its live dump of the database; switching the module off and on refuses with DUMP_SERIES naming it, the database stays blocked, nothing is applied; after the discard it succeeds', async () => {
    const X = uuidv7()
    const db = tenantModuleDbName(X, 'lcfix')
    const dir = freshDumpDir()
    await enableModule(X, lcfix(), OPERATOR, deps(null, { releaseRef: 'dist-v0.0.1' }))
    await ownerQuery(server, db, 'm_lcfix', (sql) => sql`INSERT INTO item (customer_id, note) VALUES (${X}, 'kept')`)
    // the failed release's dump set took this (then enabled) database
    await takeDump({
      dir,
      release: 'dist-vFAILED',
      database: db,
      scope: 'customer',
      customerId: X,
      moduleId: 'lcfix',
      exporter: exporterFor(),
      service: MOD_SERVICE,
      pgUser: stack().user,
      probe: { serverMajor: async () => 18, pgDumpMajor: async () => 18, databaseBytes: async () => 1000 },
      fs: dumpFs(),
      audit: () => {},
    })
    // the executor switches it off (export, block) while the failed release's set is still live
    await disableModule(X, lcfix(), OPERATOR, deps(null, { releaseRef: 'dist-v0.0.1' }))
    expect(await stateOf(X, 'lcfix')).toBe('blocked')
    const mod = withExtra(lcfix())
    const c = catchup(dir)
    await expect(enableModule(X, mod, OPERATOR, deps(c))).rejects.toThrow(/DUMP_SERIES.*dist-vFAILED.*gremion-migration-dump discard --release dist-vFAILED/s)
    expect(await stateOf(X, 'lcfix')).toBe('blocked')
    expect(await appConnectCode(db, 'm_lcfix_app', stack().modulePort)).toBe('42501')
    expect((await ownerQuery(server, db, 'm_lcfix', (sql) => sql<{ filename: string }[]>`SELECT filename FROM public.schema_migrations ORDER BY 1`)).map((x) => x.filename)).toEqual(['001_init.sql', '002_item_customer_idx.sql'])
    expect(liveDumps(readEvents(dir)).map((e) => e.release)).toEqual(['dist-vFAILED'])
    // the operator discards (the verified export of the switch-off is an equivalent restore point): the switch-on goes through
    await retireDump(dir, 'dist-vFAILED', db, 'discard', { fs: dumpFs(), audit: () => {} })
    const r = await enableModule(X, mod, OPERATOR, deps(c))
    expect(r.applied).toEqual(['003_extra.sql'])
    expect(liveDumps(readEvents(dir))).toEqual([])
    expect(await stateOf(X, 'lcfix')).toBe('enabled')
  }, 120_000)
})
