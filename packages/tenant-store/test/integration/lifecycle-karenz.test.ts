// Task 3 (module Karenz, phase 2) on the scratch stack: a switch-off exports,
// verifies and then BLOCKS the module database (the app role loses CONNECT,
// its sessions end) instead of dropping it; plt.module_karenz carries the
// 30-day clock; a switch-on within the 30 days restores; finalizeDueKarenz
// drops and deletes on day 30, guarded by the deletion switch, crash-safe at
// every step and refusing to drop without the row's own verified export.
import { createHash, randomBytes } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Sql } from '@gremion/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { disableModule, enableModule } from '../../src/lifecycle/index.js'
import { finalizeDueKarenz, type FinalizeDeps } from '../../src/lifecycle/karenz.js'
import type { Exporter, LifecycleModule } from '../../src/lifecycle/types.js'
import { tenantModuleDbName } from '../../src/names.js'
import { connectModuleAs } from '../harness/db.js'
import {
  APP_PASSWORD,
  containerExporter,
  databasesOn,
  EXPORT_ROOT,
  LCFIX_DIR,
  lcfixModule,
  lifecycleDeps,
  moduleServer,
  OPERATOR,
  platformDb,
  resetModuleServer,
  seedCatalogue,
  uuidv7,
} from '../harness/lifecycle.js'

const DAY = 24 * 3600 * 1000

describe('the module Karenz on the scratch stack', () => {
  let platform: Sql
  let server: ReturnType<typeof moduleServer>
  const scratchModules: string[] = []

  const exportDir = () => lifecycleDeps(platform, server).exportDir
  const exportFiles = (X: string) => {
    const d = join(exportDir(), X, 'lcfix')
    return existsSync(d) ? readdirSync(d).sort() : []
  }

  type KarenzRow = {
    karenz_id: string
    state: string
    final_at: Date
    switched_off_at: Date
    export_path: string | null
    export_sha256: string | null
    export_deleted_at: Date | null
    export_kept_until: Date | null
    final_mode: string | null
    platform_done_at: Date | null
    tenant_done_at: Date | null
    restore_requested_at: Date | null
    restored_at: Date | null
    actor_kind: string
    actor_id: string | null
    full: boolean
  }
  const karenz = (X: string) =>
    platform<KarenzRow[]>`
      SELECT k.karenz_id::text, k.state, k.final_at, k.switched_off_at, k.export_path, k.export_sha256, k.export_deleted_at,
             k.export_kept_until, k.final_mode, k.platform_done_at, k.tenant_done_at, k.restore_requested_at, k.restored_at,
             k.actor_kind, k.actor_id::text, (k.final_at = k.switched_off_at + interval '30 days') AS full
        FROM plt.module_karenz k JOIN plt.module m USING (module_id)
       WHERE k.customer_id = ${X} AND m.module_key = 'lcfix' ORDER BY k.switched_off_at, k.karenz_id`
  const moduleDatabase = async (X: string) =>
    (
      await platform<{ state: string; export_path: string | null; export_sha256: string | null }[]>`
        SELECT d.state, d.export_path, d.export_sha256
          FROM plt.module_database d JOIN plt.module m USING (module_id)
         WHERE d.customer_id = ${X} AND m.module_key = 'lcfix'`
    )[0]
  const enablement = async (X: string) =>
    (
      await platform<{ state: string }[]>`
        SELECT e.state FROM plt.module_enablement e JOIN plt.module m USING (module_id)
         WHERE e.customer_id = ${X} AND m.module_key = 'lcfix'`
    )[0]?.state

  /** The clock moves, not the code: both columns go back so final_at > switched_off_at still holds. */
  const backdate = (karenzId: string) =>
    platform`UPDATE plt.module_karenz SET switched_off_at = now() - interval '31 days', final_at = now() - interval '1 day' WHERE karenz_id = ${karenzId}`

  const enableWithRow = async (X: string, module: LifecycleModule = lcfixModule()) => {
    await enableModule(X, module, OPERATOR, lifecycleDeps(platform, server))
    const sql = server.open(tenantModuleDbName(X, 'lcfix'), { role: 'm_lcfix' }) as Sql
    try {
      await sql`INSERT INTO item (customer_id, note) VALUES (${X}, 'kept through the Karenz')`
    } finally {
      await sql.end({ timeout: 5 })
    }
  }

  const finDeps = (overrides: Partial<FinalizeDeps> = {}): FinalizeDeps => ({
    platform,
    server: () => server,
    catalogue: [lcfixModule()],
    exportDir: exportDir(),
    exportStorage: lifecycleDeps(platform, server).exportStorage!,
    finalDeletion: true,
    now: () => new Date(Date.now() + 40 * DAY),
    ...overrides,
  })

  /** An enabled, written-to, switched-off, back-dated tenant: ready for day 30. */
  const dueTenant = async () => {
    const X = uuidv7()
    await enableWithRow(X)
    const r = await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
    await backdate(r.karenz!.karenzId)
    return { X, db: tenantModuleDbName(X, 'lcfix'), karenzId: r.karenz!.karenzId, exportPath: r.export!.path }
  }

  const appConnectCode = async (db: string): Promise<string | undefined> => {
    const own = connectModuleAs(db, 'm_lcfix_app', APP_PASSWORD)
    try {
      await own`SELECT 1`
      return undefined
    } catch (err) {
      return (err as { code?: string }).code
    } finally {
      await own.end({ timeout: 1 }).catch(() => {})
    }
  }

  /** A copy of the lcfix module with one more migration (the release moved on while the module was off). */
  const moduleWithExtraMigration = (
    sql = '-- lifecycle fixture module lcfix, 003 (added while the module was off)\nCREATE TABLE extra (extra_id uuid PRIMARY KEY DEFAULT uuidv7(), note text NOT NULL);\n',
  ): LifecycleModule => {
    mkdirSync(EXPORT_ROOT, { recursive: true })
    const dir = mkdtempSync(join(EXPORT_ROOT, 'karenz-mod-'))
    scratchModules.push(dir)
    cpSync(LCFIX_DIR, dir, { recursive: true })
    writeFileSync(join(dir, 'migrations', '003_extra.sql'), sql)
    const manifestPath = join(dir, 'migrations', 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, string>
    manifest['003_extra.sql'] = createHash('sha256').update(sql).digest('hex')
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    return { ...lcfixModule(), dir }
  }

  beforeAll(async () => {
    platform = platformDb()
    server = moduleServer()
    await seedCatalogue(platform, 'lcfix')
    await resetModuleServer(server.admin, platform)
  })

  // every spec starts with no database, row or export of an earlier one: a spec that leaves a due Karenz
  // row behind would otherwise report its error in every later finalize run
  beforeEach(async () => {
    await resetModuleServer(server.admin, platform)
    rmSync(exportDir(), { recursive: true, force: true })
  })

  afterAll(async () => {
    rmSync(exportDir(), { recursive: true, force: true })
    await resetModuleServer(server.admin, platform)
    await server.close()
    await platform.end()
    for (const d of scratchModules) rmSync(d, { recursive: true, force: true })
  })

  describe('switch-off', () => {
    it('disable exports, then blocks: the database still exists, the app role cannot connect (42501), the owner can, one open row has final_at = switched_off_at + 30 days, dropped is false', async () => {
      const X = uuidv7()
      const db = tenantModuleDbName(X, 'lcfix')
      await enableWithRow(X)
      expect(await appConnectCode(db)).toBeUndefined() // control: it connects before the switch-off
      const r = await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
      expect(r).toMatchObject({ dropped: false, blocked: true, noop: false, database: db })
      expect(r.karenz).not.toBeNull()
      expect(await databasesOn(server.admin)).toContain(db)
      expect(await appConnectCode(db)).toBe('42501')
      const owner = server.open(db, { role: 'm_lcfix' }) as Sql
      try {
        expect((await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM item`)[0]?.n).toBe(1)
      } finally {
        await owner.end({ timeout: 5 })
      }
      expect(await moduleDatabase(X)).toMatchObject({ state: 'blocked', export_path: r.export!.path, export_sha256: r.export!.sha256 })
      expect(await enablement(X)).toBe('disabled')
      const rows = await karenz(X)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        karenz_id: r.karenz!.karenzId,
        state: 'open',
        full: true,
        export_path: r.export!.path,
        export_sha256: r.export!.sha256,
        actor_kind: 'operator',
        actor_id: OPERATOR.id,
        final_mode: null,
      })
      expect(rows[0]!.final_at.getTime()).toBe(r.karenz!.finalAt.getTime())
    })

    it('a recording exporter proves dump and verify happen before the revoke', async () => {
      const X = uuidv7()
      await enableWithRow(X)
      const events: string[] = []
      const real = containerExporter()
      const recording: Exporter = {
        async dump(t, file) {
          events.push(`dump:${(await databasesOn(server.admin)).includes(t.database) ? 'present' : 'absent'}`)
          await real.dump(t, file)
        },
        async list(file) {
          events.push('list')
          return real.list(file)
        },
      }
      const recordingAdmin = new Proxy(server.admin, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver)
          if (prop === 'unsafe') {
            return (q: string, ...rest: unknown[]) => {
              if (q.startsWith('REVOKE CONNECT ON DATABASE')) events.push('revoke')
              if (q.startsWith('DROP DATABASE')) events.push('drop')
              return (v as (...a: unknown[]) => unknown).call(target, q, ...rest)
            }
          }
          return typeof v === 'function' ? v.bind(target) : v
        },
        apply(target, thisArg, args) {
          return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args)
        },
      })
      await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, { ...server, admin: recordingAdmin, open: server.open }, { exporter: recording }))
      expect(events).toEqual(['dump:present', 'list', 'revoke'])
    })

    it('a second disable keeps the same karenz_id and final_at', async () => {
      const X = uuidv7()
      await enableWithRow(X)
      const first = await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
      const again = await disableModule(X, lcfixModule(), { kind: 'person', id: uuidv7() }, lifecycleDeps(platform, server))
      expect(again).toMatchObject({ noop: true, blocked: true, dropped: false })
      expect(again.karenz).toEqual(first.karenz)
      const rows = await karenz(X)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ karenz_id: first.karenz!.karenzId, actor_kind: 'operator', actor_id: OPERATOR.id })
      expect(rows[0]!.final_at.getTime()).toBe(first.karenz!.finalAt.getTime())
      expect(exportFiles(X).filter((f) => f.endsWith('.dump'))).toHaveLength(1)
    })

    it('disable of a database-less module writes the karenz row only; disable of a never-enabled module writes none', async () => {
      const X = uuidv7()
      const noDb = lcfixModule({ database: null, export: null })
      await enableModule(X, noDb, OPERATOR, lifecycleDeps(platform, server))
      const r = await disableModule(X, noDb, OPERATOR, lifecycleDeps(platform, server))
      expect(r).toMatchObject({ database: null, dropped: false, blocked: false, export: null })
      expect(r.karenz).not.toBeNull()
      expect(await enablement(X)).toBe('disabled')
      expect(await moduleDatabase(X)).toBeUndefined()
      const rows = await karenz(X)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ state: 'open', full: true, export_path: null, export_sha256: null })
      // a second disable adds no row and no new 30 days
      const again = await disableModule(X, noDb, OPERATOR, lifecycleDeps(platform, server))
      expect(again.noop).toBe(true)
      expect(again.karenz).toEqual(r.karenz)
      expect(await karenz(X)).toHaveLength(1)

      const never = uuidv7()
      expect(await disableModule(never, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))).toMatchObject({ noop: true, karenz: null, blocked: false })
      expect(await disableModule(never, noDb, OPERATOR, lifecycleDeps(platform, server))).toMatchObject({ noop: true, karenz: null })
      expect(await karenz(never)).toHaveLength(0)
    })

    it('a crash after the export and before the block (hooks.afterStep) resumes to exactly one karenz row and one export file', async () => {
      const X = uuidv7()
      const db = tenantModuleDbName(X, 'lcfix')
      await enableWithRow(X)
      const crash = lifecycleDeps(platform, server, {
        hooks: {
          afterStep: (step) => {
            if (step === 'exported') throw new Error('crash after the export')
          },
        },
      })
      await expect(disableModule(X, lcfixModule(), OPERATOR, crash)).rejects.toThrow('crash after the export')
      expect(await moduleDatabase(X)).toMatchObject({ state: 'disabling' })
      expect(await karenz(X)).toHaveLength(0)
      expect(await appConnectCode(db)).toBeUndefined() // not blocked yet
      expect(exportFiles(X).filter((f) => f.endsWith('.dump'))).toHaveLength(1)

      const r = await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
      expect(r).toMatchObject({ blocked: true, dropped: false })
      expect(await appConnectCode(db)).toBe('42501')
      const rows = await karenz(X)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.export_path).toBe(r.export!.path)
      // the export of the crashed attempt is replaced, not left behind as an orphan
      expect(exportFiles(X).filter((f) => f.endsWith('.dump'))).toEqual([r.export!.path.split(/[\\/]/).pop()])
    })
  })

  describe('switch-on within the 30 days', () => {
    it('enable of a blocked module restores: the seeded row survives, the app role connects again, a migration added meanwhile is applied, the row is restoring; no database or role DDL runs', async () => {
      const X = uuidv7()
      const db = tenantModuleDbName(X, 'lcfix')
      await enableWithRow(X)
      await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
      expect(await appConnectCode(db)).toBe('42501')

      const ddl: string[] = []
      const recordingAdmin = new Proxy(server.admin, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver)
          if (prop === 'unsafe') {
            return (q: string, ...rest: unknown[]) => {
              if (/^(CREATE|ALTER ROLE|DROP)/.test(q)) ddl.push(q)
              return (v as (...a: unknown[]) => unknown).call(target, q, ...rest)
            }
          }
          return typeof v === 'function' ? v.bind(target) : v
        },
        apply(target, thisArg, args) {
          return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args)
        },
      })
      const r = await enableModule(X, moduleWithExtraMigration(), OPERATOR, lifecycleDeps(platform, { ...server, admin: recordingAdmin, open: server.open }))
      expect(r).toMatchObject({ database: db, created: false, restored: true, noop: false, applied: ['003_extra.sql'] })
      expect(ddl).toEqual([])
      expect(await appConnectCode(db)).toBeUndefined()
      const own = connectModuleAs(db, 'm_lcfix_app', APP_PASSWORD)
      try {
        expect((await own<{ note: string }[]>`SELECT note FROM item`).map((x) => x.note)).toEqual(['kept through the Karenz'])
        await own`INSERT INTO extra (note) VALUES ('the app role has DML on the new table')`
      } finally {
        await own.end({ timeout: 1 })
      }
      expect(await moduleDatabase(X)).toMatchObject({ state: 'enabled' })
      expect(await enablement(X)).toBe('enabled')
      const rows = await karenz(X)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.state).toBe('restoring')
      expect(rows[0]!.restore_requested_at).toBeInstanceOf(Date)
    })

    it('a first enable and an enable of an already enabled module are not a restore', async () => {
      const X = uuidv7()
      expect(await enableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))).toMatchObject({ created: true, restored: false })
      expect(await enableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))).toMatchObject({ noop: true, restored: false })
      expect(await karenz(X)).toHaveLength(0)
    })

    it('enable is refused KARENZ_FINALIZING while the row is finalizing, and nothing is unblocked; disable is refused KARENZ_RESTORE_PENDING while restoring; a finished flap starts a fresh 30 days', async () => {
      const X = uuidv7()
      const db = tenantModuleDbName(X, 'lcfix')
      await enableWithRow(X)
      const off = await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
      const id = off.karenz!.karenzId

      await platform`UPDATE plt.module_karenz SET state = 'finalizing' WHERE karenz_id = ${id}`
      await expect(enableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))).rejects.toMatchObject({ code: 'KARENZ_FINALIZING' })
      expect(await appConnectCode(db)).toBe('42501')
      expect(await moduleDatabase(X)).toMatchObject({ state: 'blocked' })
      expect(await enablement(X)).toBe('disabled')

      await platform`UPDATE plt.module_karenz SET state = 'open' WHERE karenz_id = ${id}`
      await enableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
      expect((await karenz(X))[0]!.state).toBe('restoring')
      await expect(disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))).rejects.toMatchObject({ code: 'KARENZ_RESTORE_PENDING' })
      expect(await enablement(X)).toBe('enabled') // refused before anything was written
      expect(await appConnectCode(db)).toBeUndefined()
      // enabling again while the restore is pending is a no-op, not an error
      expect(await enableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))).toMatchObject({ noop: true })

      // The pass finishes the restore by reporting the `restored` mark through plt.council_karenz_report; the
      // council role does not exist in this harness, so the row is closed directly here. The real mark and the
      // off, on, off sequence without any manual UPDATE are proven in packages/provisioning
      // test/integration/karenz.int.test.ts ("switch off, on, off again, with no manual SQL").
      await platform`UPDATE plt.module_karenz SET state = 'restored', restored_at = now() WHERE karenz_id = ${id}`
      const second = await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
      expect(second.karenz!.karenzId).not.toBe(id)
      const rows = await karenz(X)
      expect(rows.map((r) => r.state)).toEqual(['restored', 'open'])
      expect(rows[1]).toMatchObject({ full: true })
      expect(rows[1]!.final_at.getTime()).toBeGreaterThan(rows[0]!.final_at.getTime())
    })
  })

  describe('a restore never leaves a blocked database reachable', () => {
    it('enable is refused once the tenant side reported tenant_done (its items are deleted): nothing is unblocked, the row stays open', async () => {
      const X = uuidv7()
      const db = tenantModuleDbName(X, 'lcfix')
      await enableWithRow(X)
      const off = await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
      await backdate(off.karenz!.karenzId)
      // day 30 passed, the platform pass failed on this row (it stays open), the tenant pass finished
      await platform`UPDATE plt.module_karenz SET final_mode = 'live', tenant_done_at = now() WHERE karenz_id = ${off.karenz!.karenzId}`

      await expect(enableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))).rejects.toMatchObject({ code: 'KARENZ_FINALIZING' })
      expect(await appConnectCode(db)).toBe('42501')
      expect(await moduleDatabase(X)).toMatchObject({ state: 'blocked' })
      expect(await enablement(X)).toBe('disabled')
      expect((await karenz(X))[0]!.state).toBe('open')
    })

    it('a failing migration during the restore leaves the database blocked and the row open', async () => {
      const X = uuidv7()
      const db = tenantModuleDbName(X, 'lcfix')
      await enableWithRow(X)
      await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))

      await expect(
        enableModule(X, moduleWithExtraMigration('-- 003 fails' + String.fromCharCode(10) + 'SELECT 1 / 0;' + String.fromCharCode(10)), OPERATOR, lifecycleDeps(platform, server)),
      ).rejects.toThrow(/division by zero/)
      expect(await appConnectCode(db)).toBe('42501')
      expect(await moduleDatabase(X)).toMatchObject({ state: 'blocked' })
      expect(await enablement(X)).toBe('disabled')
      expect((await karenz(X))[0]!.state).toBe('open')
    })

    it('the day-30 job claiming the row while the restore is in flight re-blocks the database the restore had opened', async () => {
      const X = uuidv7()
      const db = tenantModuleDbName(X, 'lcfix')
      await enableWithRow(X)
      const off = await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))

      const deps = lifecycleDeps(platform, server)
      await expect(
        enableModule(X, lcfixModule(), OPERATOR, {
          ...deps,
          hooks: {
            afterStep: async (step) => {
              if (step === 'unblocked') await platform`UPDATE plt.module_karenz SET state = 'finalizing' WHERE karenz_id = ${off.karenz!.karenzId}`
            },
          },
        }),
      ).rejects.toMatchObject({ code: 'KARENZ_FINALIZING' })
      expect(await appConnectCode(db)).toBe('42501')
      expect(await moduleDatabase(X)).toMatchObject({ state: 'blocked' })
      expect(await enablement(X)).toBe('disabled')
    })

    it('a failed re-block after a failed restore is not swallowed: the error carries both failures and says the app role can still connect', async () => {
      const X = uuidv7()
      const db = tenantModuleDbName(X, 'lcfix')
      const grp = `grp_${randomBytes(6).toString('hex')}`
      await enableWithRow(X)
      await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))

      const deps = lifecycleDeps(platform, server)
      try {
        const failure = await enableModule(X, lcfixModule(), OPERATOR, {
          ...deps,
          hooks: {
            afterStep: async (step) => {
              if (step !== 'unblocked') return
              // CONNECT through a group role: the re-block revokes it from the app role only, so its own proof fails
              await server.admin.unsafe(`CREATE ROLE ${grp} NOLOGIN`)
              await server.admin.unsafe(`GRANT CONNECT ON DATABASE "${db}" TO ${grp}`)
              await server.admin.unsafe(`GRANT ${grp} TO m_lcfix_app WITH INHERIT TRUE`)
              throw new Error('hook failed after the unblock')
            },
          },
        }).then(
          () => null,
          (err: unknown) => err as Error & { code?: string; cause?: unknown },
        )
        expect(failure).not.toBeNull()
        expect(failure).toMatchObject({ code: 'CONCURRENT_STATE' })
        expect(failure!.message).toMatch(/hook failed after the unblock/)
        expect(failure!.message).toMatch(/re-block/)
        expect(failure!.message).toMatch(/can still connect/)
        expect(failure!.cause).toBeInstanceOf(AggregateError)
        expect((failure!.cause as AggregateError).errors).toHaveLength(2)
        // the platform still reads blocked/disabled: the error is what tells the caller the database is reachable
        expect(await appConnectCode(db)).toBeUndefined()
        expect(await moduleDatabase(X)).toMatchObject({ state: 'blocked' })
        expect(await enablement(X)).toBe('disabled')
      } finally {
        await server.admin.unsafe(`REVOKE ${grp} FROM m_lcfix_app`).catch(() => {})
        await server.admin.unsafe(`REVOKE CONNECT ON DATABASE "${db}" FROM ${grp}`).catch(() => {})
        await server.admin.unsafe(`DROP ROLE IF EXISTS ${grp}`).catch(() => {})
      }
    })

    it('disable of an already blocked module re-asserts the block: a CONNECT granted back by hand is revoked again', async () => {
      const X = uuidv7()
      const db = tenantModuleDbName(X, 'lcfix')
      await enableWithRow(X)
      await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
      await server.admin.unsafe(`GRANT CONNECT ON DATABASE "${db}" TO m_lcfix_app`)
      expect(await appConnectCode(db)).toBeUndefined() // control: the stray grant works

      const again = await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
      expect(again).toMatchObject({ blocked: true, noop: true })
      expect(await appConnectCode(db)).toBe('42501')
    })
  })

  describe('day 30', () => {
    it('finalize with finalDeletion false changes nothing except recording final_mode dry on the due rows, and reports due 1', async () => {
      const t = await dueTenant()
      const notDue = uuidv7() // a second tenant whose Karenz has just begun is not due
      await enableWithRow(notDue)
      await disableModule(notDue, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))

      const r = await finalizeDueKarenz(finDeps({ finalDeletion: false, now: () => new Date() }))
      expect(r).toMatchObject({ due: 1, finalized: 0, kept: 0, dryRun: true, errors: [] })
      expect(await databasesOn(server.admin)).toContain(t.db)
      expect(existsSync(t.exportPath)).toBe(true)
      expect(await moduleDatabase(t.X)).toMatchObject({ state: 'blocked' })
      expect((await karenz(t.X))[0]).toMatchObject({ state: 'open', final_mode: 'dry', platform_done_at: null, export_deleted_at: null })
      expect((await karenz(notDue))[0]).toMatchObject({ state: 'open', final_mode: null })

      // flipping the switch converts the recorded mode and runs
      const live = await finalizeDueKarenz(finDeps({ now: () => new Date() }))
      expect(live).toMatchObject({ due: 1, finalized: 1, dryRun: false, errors: [] })
      expect((await karenz(t.X))[0]).toMatchObject({ final_mode: 'live' })
    })

    it('finalize drops the database, deletes the export and its sidecar, sets platform_done_at', async () => {
      const t = await dueTenant()
      expect(existsSync(`${t.exportPath}.sha256`)).toBe(true)
      const r = await finalizeDueKarenz(finDeps({ now: () => new Date() }))
      expect(r).toMatchObject({ due: 1, finalized: 1, kept: 0, dryRun: false, errors: [] })
      expect(await databasesOn(server.admin)).not.toContain(t.db)
      expect(existsSync(t.exportPath)).toBe(false)
      expect(existsSync(`${t.exportPath}.sha256`)).toBe(false)
      expect(await moduleDatabase(t.X)).toMatchObject({ state: 'dropped' })
      const row = (await karenz(t.X))[0]!
      expect(row).toMatchObject({ state: 'finalizing', final_mode: 'live' })
      expect(row.platform_done_at).toBeInstanceOf(Date)
      expect(row.export_deleted_at).toBeInstanceOf(Date)
      expect(row.tenant_done_at).toBeNull()
      // a second run has nothing to do
      expect(await finalizeDueKarenz(finDeps({ now: () => new Date() }))).toMatchObject({ due: 0, finalized: 0, errors: [] })
    })

    it('finalize refuses the drop when the export file is missing or its sha256 differs, keeps the database, returns the error', async () => {
      const missing = await dueTenant()
      const saved = Buffer.from(randomBytes(16))
      rmSync(missing.exportPath)
      const r1 = await finalizeDueKarenz(finDeps({ now: () => new Date() }))
      expect(r1.errors).toHaveLength(1)
      expect(r1.errors[0]).toMatchObject({ karenzId: missing.karenzId, moduleKey: 'lcfix' })
      expect(r1.errors[0]!.message).toMatch(/EXPORT_MISSING/)
      expect(r1.finalized).toBe(0)
      expect(await databasesOn(server.admin)).toContain(missing.db)
      expect(await moduleDatabase(missing.X)).toMatchObject({ state: 'blocked' })

      // the same file name, other bytes: the checksum no longer matches
      writeFileSync(missing.exportPath, saved)
      const r2 = await finalizeDueKarenz(finDeps({ now: () => new Date() }))
      expect(r2.errors).toHaveLength(1)
      expect(r2.errors[0]!.message).toMatch(/EXPORT_MISSING/)
      expect(await databasesOn(server.admin)).toContain(missing.db)
      expect((await karenz(missing.X))[0]!.platform_done_at).toBeNull()
      rmSync(missing.exportPath)
    })

    it('a re-run after a crash between DROP DATABASE and the row update converges to dropped; switch-on is refused KARENZ_FINALIZING meanwhile', async () => {
      const t = await dueTenant()
      const crash = finDeps({
        now: () => new Date(),
        hooks: {
          afterStep: (step) => {
            if (step === 'db-dropped') throw new Error('crash after the drop')
          },
        },
      })
      const r1 = await finalizeDueKarenz(crash)
      expect(r1.errors).toHaveLength(1)
      expect(r1.errors[0]!.message).toMatch(/crash after the drop/)
      expect(await databasesOn(server.admin)).not.toContain(t.db)
      expect(await moduleDatabase(t.X)).toMatchObject({ state: 'blocked' }) // the row never learned of the drop
      expect((await karenz(t.X))[0]!.state).toBe('finalizing')
      await expect(enableModule(t.X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))).rejects.toMatchObject({ code: 'KARENZ_FINALIZING' })
      expect(await moduleDatabase(t.X)).toMatchObject({ state: 'blocked' }) // never half restored

      const r2 = await finalizeDueKarenz(finDeps({ now: () => new Date() }))
      expect(r2.errors).toEqual([])
      expect(await moduleDatabase(t.X)).toMatchObject({ state: 'dropped' })
      expect(existsSync(t.exportPath)).toBe(false)
    })

    for (const step of ['cas-finalizing', 'export-verified', 'db-dropped', 'cas-dropped', 'export-deleted', 'platform-done'] as const) {
      it(`a crash after ${step} followed by a re-run converges: database gone, module_database dropped, export deleted, platform_done_at set, never EXPORT_MISSING and never a failed second drop`, async () => {
        const t = await dueTenant()
        let crashed = false
        const r1 = await finalizeDueKarenz(
          finDeps({
            now: () => new Date(),
            hooks: {
              afterStep: (s) => {
                if (s === step && !crashed) {
                  crashed = true
                  throw new Error(`crash after ${step}`)
                }
              },
            },
          }),
        )
        expect(crashed).toBe(true)
        expect(r1.errors).toHaveLength(1)
        expect(r1.errors[0]!.message).toMatch(new RegExp(`crash after ${step}`))

        const r2 = await finalizeDueKarenz(finDeps({ now: () => new Date() }))
        expect(r2.errors).toEqual([])
        expect(JSON.stringify(r2)).not.toMatch(/EXPORT_MISSING/)
        expect(await databasesOn(server.admin)).not.toContain(t.db)
        expect(await moduleDatabase(t.X)).toMatchObject({ state: 'dropped' })
        expect(existsSync(t.exportPath)).toBe(false)
        expect(existsSync(`${t.exportPath}.sha256`)).toBe(false)
        const row = (await karenz(t.X))[0]!
        expect(row.export_deleted_at).toBeInstanceOf(Date)
        expect(row.platform_done_at).toBeInstanceOf(Date)
        expect(row.state).toBe('finalizing')
        // and a third run is quiet
        expect(await finalizeDueKarenz(finDeps({ now: () => new Date() }))).toMatchObject({ due: 0, errors: [] })
      }, 120_000)
    }

    it('a missing export file with module_database already dropped is success, not EXPORT_MISSING', async () => {
      const t = await dueTenant()
      let crashed = false
      await finalizeDueKarenz(
        finDeps({
          now: () => new Date(),
          hooks: {
            afterStep: (s) => {
              if (s === 'cas-dropped' && !crashed) {
                crashed = true
                throw new Error('stop after the row says dropped')
              }
            },
          },
        }),
      )
      expect(await moduleDatabase(t.X)).toMatchObject({ state: 'dropped' })
      rmSync(t.exportPath)
      rmSync(`${t.exportPath}.sha256`)
      const r = await finalizeDueKarenz(finDeps({ now: () => new Date() }))
      expect(r.errors).toEqual([])
      expect((await karenz(t.X))[0]).toMatchObject({ platform_done_at: expect.any(Date), export_deleted_at: expect.any(Date) })
    })

    it('platform_done_at set while tenant_done_at is already set finalizes the row', async () => {
      const t = await dueTenant()
      await platform`UPDATE plt.module_karenz SET tenant_done_at = now() WHERE karenz_id = ${t.karenzId}`
      const r = await finalizeDueKarenz(finDeps({ now: () => new Date() }))
      expect(r.errors).toEqual([])
      expect((await karenz(t.X))[0]).toMatchObject({ state: 'finalized', platform_done_at: expect.any(Date), tenant_done_at: expect.any(Date) })
    })

    it("finalize deletes the row's OWN export: a restored Karenz's export is deleted at its final_at, and a later second disable's export is untouched", async () => {
      const X = uuidv7()
      await enableWithRow(X)
      const first = await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
      await enableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
      await platform`UPDATE plt.module_karenz SET state = 'restored', restored_at = now() WHERE karenz_id = ${first.karenz!.karenzId}`
      await backdate(first.karenz!.karenzId)
      const second = await disableModule(X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
      expect(second.export!.path).not.toBe(first.export!.path)
      expect(existsSync(first.export!.path)).toBe(true)

      const r = await finalizeDueKarenz(finDeps({ now: () => new Date() }))
      expect(r.errors).toEqual([])
      expect(r.due).toBe(1)
      expect(existsSync(first.export!.path)).toBe(false)
      expect(existsSync(`${first.export!.path}.sha256`)).toBe(false)
      expect(existsSync(second.export!.path)).toBe(true)
      expect(await databasesOn(server.admin)).toContain(tenantModuleDbName(X, 'lcfix'))
      expect(await moduleDatabase(X)).toMatchObject({ state: 'blocked', export_path: second.export!.path })
      const rows = await karenz(X)
      expect(rows[0]).toMatchObject({ state: 'restored', export_deleted_at: expect.any(Date) })
      expect(rows[1]).toMatchObject({ state: 'open', export_deleted_at: null, platform_done_at: null })
    })

    it('orphaned exports are listed in the result and never deleted', async () => {
      const t = await dueTenant()
      const stray = join(exportDir(), t.X, 'lcfix', '20200101T000000000Z.dump')
      writeFileSync(stray, 'a backup the operator may still want')
      const dry = await finalizeDueKarenz(finDeps({ finalDeletion: false, now: () => new Date() }))
      expect(dry.orphanedExports).toContain(stray)
      expect(dry.orphanedExports).not.toContain(t.exportPath)
      const live = await finalizeDueKarenz(finDeps({ now: () => new Date() }))
      expect(live.orphanedExports).toContain(stray)
      expect(existsSync(stray)).toBe(true)
      expect(existsSync(t.exportPath)).toBe(false) // the referenced one went with its Karenz
      rmSync(stray)
    })

    it('exportHold in the future keeps the file and records export_kept_until', async () => {
      const t = await dueTenant()
      const until = new Date(Date.now() + 365 * DAY)
      const seen: [string, string][] = []
      const r = await finalizeDueKarenz(
        finDeps({
          now: () => new Date(),
          exportHold: (tenantId, moduleId) => {
            seen.push([tenantId, moduleId])
            return until
          },
        }),
      )
      expect(r).toMatchObject({ finalized: 1, kept: 1, errors: [] })
      expect(seen).toEqual([[t.X, 'lcfix']])
      expect(existsSync(t.exportPath)).toBe(true)
      const row = (await karenz(t.X))[0]!
      expect(row.export_deleted_at).toBeNull()
      expect(row.export_kept_until?.getTime()).toBe(until.getTime())
      expect(row.platform_done_at).toBeInstanceOf(Date)
      expect(await moduleDatabase(t.X)).toMatchObject({ state: 'dropped' })
      rmSync(t.exportPath)
      rmSync(`${t.exportPath}.sha256`)
    })

    it('a module in retentionRequired without retained_ok_at is not dropped', async () => {
      const t = await dueTenant()
      const guarded = finDeps({ now: () => new Date(), retentionRequired: new Set(['lcfix']) })
      const r = await finalizeDueKarenz(guarded)
      expect(r.errors).toHaveLength(1)
      expect(r.errors[0]!.message).toMatch(/retain/i)
      expect(await databasesOn(server.admin)).toContain(t.db)
      expect((await karenz(t.X))[0]).toMatchObject({ state: 'open', platform_done_at: null })

      await platform`UPDATE plt.module_karenz SET retained_ok_at = now() WHERE karenz_id = ${t.karenzId}`
      const ok = await finalizeDueKarenz(guarded)
      expect(ok.errors).toEqual([])
      expect(await databasesOn(server.admin)).not.toContain(t.db)
    })

    it('enable after day 30 creates a fresh database', async () => {
      const t = await dueTenant()
      await finalizeDueKarenz(finDeps({ now: () => new Date() }))
      expect(await databasesOn(server.admin)).not.toContain(t.db)
      // the tenant side reports its half (Task 8): the row is finalized
      await platform`UPDATE plt.module_karenz SET tenant_done_at = now(), state = 'finalized' WHERE karenz_id = ${t.karenzId}`
      const r = await enableModule(t.X, lcfixModule(), OPERATOR, lifecycleDeps(platform, server))
      expect(r).toMatchObject({ database: t.db, created: true, restored: false, applied: ['001_init.sql', '002_item_customer_idx.sql'] })
      const own = connectModuleAs(t.db, 'm_lcfix_app', APP_PASSWORD)
      try {
        expect((await own<{ n: number }[]>`SELECT count(*)::int AS n FROM item`)[0]?.n).toBe(0)
      } finally {
        await own.end({ timeout: 1 })
      }
    })
  })
})
