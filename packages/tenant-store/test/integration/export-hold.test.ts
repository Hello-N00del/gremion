// The export hold of the day-30 job on the scratch stack: a module whose export is held keeps its dump (and the
// sidecar) after the database is dropped, the dump still verifies and restores, a repeated or crashed run
// decides the same way, and a module with no hold, a restored Karenz and a dry run delete or keep nothing new.
// The module `lcfix` stands in for a held module through the hold function below (the package does not know
// which real modules are held: that table lives in @gremion/provisioning); `lcfixplain` has no entry.
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname } from 'node:path'
import type { Sql } from '@gremion/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { disableModule, enableModule } from '../../src/lifecycle/index.js'
import { finalizeDueKarenz, verifyRowExport, type DueRow, type ExportHoldContext, type FinalizeDeps } from '../../src/lifecycle/karenz.js'
import type { LifecycleModule } from '../../src/lifecycle/types.js'
import { tenantModuleDbName } from '../../src/names.js'
import { stack } from '../harness/db.js'
import { databasesOn, lcfixModule, lifecycleDeps, moduleServer, OPERATOR, platformDb, resetModuleServer, scratchExportStorage, seedCatalogue, uuidv7 } from '../harness/lifecycle.js'

const DAY = 24 * 3600 * 1000
const KEEP_DAYS = 365
const heldModule = lcfixModule()
const plainModule = (): LifecycleModule => ({ ...lcfixModule(), id: 'lcfixplain', moduleJson: { ...lcfixModule().moduleJson, id: 'lcfixplain' } })
const hold = (_tenant: string, moduleKey: string, c: ExportHoldContext): Date | null => (moduleKey === 'lcfix' ? new Date(c.finalAt.getTime() + KEEP_DAYS * DAY) : null)

describe('the export hold on the scratch stack', () => {
  let platform: Sql
  let server: ReturnType<typeof moduleServer>
  const exportDir = () => lifecycleDeps(platform, server).exportDir

  type KarenzRow = {
    karenz_id: string
    state: string
    final_at: Date
    export_path: string | null
    export_sha256: string | null
    export_deleted_at: Date | null
    export_kept_until: Date | null
    platform_done_at: Date | null
  }
  const karenz = async (X: string, key = 'lcfix') =>
    (
      await platform<KarenzRow[]>`
        SELECT k.karenz_id::text, k.state, k.final_at, k.export_path, k.export_sha256, k.export_deleted_at, k.export_kept_until, k.platform_done_at
          FROM plt.module_karenz k JOIN plt.module m USING (module_id)
         WHERE k.customer_id = ${X} AND m.module_key = ${key} ORDER BY k.switched_off_at, k.karenz_id`
    )[0]!
  const moduleDatabaseState = async (X: string, key = 'lcfix') =>
    (
      await platform<{ state: string }[]>`
        SELECT d.state FROM plt.module_database d JOIN plt.module m USING (module_id) WHERE d.customer_id = ${X} AND m.module_key = ${key}`
    )[0]?.state

  const backdate = (karenzId: string) =>
    platform`UPDATE plt.module_karenz SET switched_off_at = now() - interval '31 days', final_at = now() - interval '1 day' WHERE karenz_id = ${karenzId}`

  const finDeps = (module: LifecycleModule, overrides: Partial<FinalizeDeps> = {}): FinalizeDeps => ({
    platform,
    server: () => server,
    catalogue: [heldModule, plainModule()],
    exportDir: exportDir(),
    exportStorage: scratchExportStorage(exportDir()),
    finalDeletion: true,
    exportHold: hold,
    ...overrides,
  })

  /** An enabled, written-to, switched-off, back-dated tenant: ready for day 30. */
  const dueTenant = async (module: LifecycleModule = heldModule) => {
    const X = uuidv7()
    await enableModule(X, module, OPERATOR, lifecycleDeps(platform, server))
    const db = tenantModuleDbName(X, module.id)
    const sql = server.open(db, { role: `m_${module.id}` }) as Sql
    try {
      await sql`INSERT INTO item (customer_id, note) VALUES (${X}, 'kept past day 30')`
    } finally {
      await sql.end({ timeout: 5 })
    }
    const r = await disableModule(X, module, OPERATOR, lifecycleDeps(platform, server))
    await backdate(r.karenz!.karenzId)
    return { X, db, key: module.id, karenzId: r.karenz!.karenzId, exportPath: r.export!.path }
  }

  const asDueRow = (X: string, key: string, k: KarenzRow): DueRow => ({
    karenz_id: k.karenz_id,
    customer_id: X,
    module_id: 'unused',
    module_key: key,
    state: k.state as DueRow['state'],
    export_path: k.export_path,
    export_sha256: k.export_sha256,
    export_deleted_at: k.export_deleted_at,
    platform_done_at: k.platform_done_at,
    tenant_done_at: null,
    retained_ok_at: null,
    final_at: k.final_at,
    export_kept_until: k.export_kept_until,
  })

  beforeAll(async () => {
    platform = platformDb()
    server = moduleServer()
    await seedCatalogue(platform, 'lcfix')
    await seedCatalogue(platform, 'lcfixplain')
    await resetModuleServer(server.admin, platform)
  })
  beforeEach(async () => {
    await resetModuleServer(server.admin, platform)
    rmSync(exportDir(), { recursive: true, force: true })
  })
  afterAll(async () => {
    rmSync(exportDir(), { recursive: true, force: true })
    await resetModuleServer(server.admin, platform)
    await server.close()
    await platform.end()
  })

  it('day 30: the database is dropped, the dump and its sidecar stay, the row records the kept date, the kept dump verifies and restores with its rows', async () => {
    const t = await dueTenant()
    const r = await finalizeDueKarenz(finDeps(heldModule, { now: () => new Date() }))
    expect(r).toMatchObject({ finalized: 1, kept: 1, errors: [] })
    expect(await databasesOn(server.admin)).not.toContain(t.db)
    expect(existsSync(t.exportPath)).toBe(true)
    expect(existsSync(`${t.exportPath}.sha256`)).toBe(true)
    const k = await karenz(t.X)
    expect(k.export_deleted_at).toBeNull()
    expect(k.platform_done_at).toBeInstanceOf(Date)
    expect(k.export_kept_until?.getTime()).toBe(k.final_at.getTime() + KEEP_DAYS * DAY)
    expect(await moduleDatabaseState(t.X)).toBe('dropped')
    await expect(verifyRowExport(exportDir(), asDueRow(t.X, t.key, k))).resolves.toBeUndefined()

    // the kept file is a real backup: it restores into a scratch database and holds the exported row
    const s = stack()
    const scratch = `t_scratch_${randomBytes(6).toString('hex')}`
    await server.admin.unsafe(`CREATE DATABASE ${scratch}`)
    const restore = spawnSync('docker', ['exec', '-i', s.moduleContainer, 'pg_restore', '-U', s.user, '--no-owner', '-d', scratch], { input: readFileSync(t.exportPath) })
    expect(restore.status, restore.stderr?.toString()).toBe(0)
    const own = server.open(scratch) as Sql
    try {
      expect(await own<{ note: string }[]>`SELECT note FROM public.item`).toEqual([{ note: 'kept past day 30' }])
    } finally {
      await own.end({ timeout: 5 })
    }
    expect(basename(dirname(t.exportPath))).toBe('lcfix')
  })

  it('a second run before the kept date selects nothing; a run after it deletes the dump and its sidecar and records export_deleted_at', async () => {
    const t = await dueTenant()
    await finalizeDueKarenz(finDeps(heldModule, { now: () => new Date() }))
    const again = await finalizeDueKarenz(finDeps(heldModule, { now: () => new Date(Date.now() + 100 * DAY) }))
    expect(again).toMatchObject({ due: 0, finalized: 0, kept: 0, errors: [] })
    expect(existsSync(t.exportPath)).toBe(true)

    const k = await karenz(t.X)
    const after = await finalizeDueKarenz(finDeps(heldModule, { now: () => new Date(k.export_kept_until!.getTime() + 1000) }))
    expect(after).toMatchObject({ due: 1, finalized: 0, kept: 0, errors: [] })
    expect(existsSync(t.exportPath)).toBe(false)
    expect(existsSync(`${t.exportPath}.sha256`)).toBe(false)
    expect((await karenz(t.X)).export_deleted_at).toBeInstanceOf(Date)
  })

  it('the release before the date: export_kept_until set to now by hand is honoured, the hold is not derived again, and the next run deletes the dump', async () => {
    const t = await dueTenant()
    await finalizeDueKarenz(finDeps(heldModule, { now: () => new Date() }))
    expect(existsSync(t.exportPath)).toBe(true)
    await platform`UPDATE plt.module_karenz SET export_kept_until = now() - interval '1 second' WHERE karenz_id = ${t.karenzId}`
    const r = await finalizeDueKarenz(finDeps(heldModule, { now: () => new Date() }))
    expect(r).toMatchObject({ due: 1, finalized: 0, kept: 0, errors: [] })
    expect(existsSync(t.exportPath)).toBe(false)
    expect(existsSync(`${t.exportPath}.sha256`)).toBe(false)
    expect((await karenz(t.X)).export_deleted_at).toBeInstanceOf(Date)
  })

  it('a module with no hold entry has its export deleted at day 30, with its database', async () => {
    const t = await dueTenant(plainModule())
    const r = await finalizeDueKarenz(finDeps(plainModule(), { now: () => new Date() }))
    expect(r).toMatchObject({ finalized: 1, kept: 0, errors: [] })
    expect(await databasesOn(server.admin)).not.toContain(t.db)
    expect(existsSync(t.exportPath)).toBe(false)
    const k = await karenz(t.X, 'lcfixplain')
    expect(k.export_deleted_at).toBeInstanceOf(Date)
    expect(k.export_kept_until).toBeNull()
  })

  it('a restored Karenz is not held: its export is deleted at its final_at and the hold is never asked', async () => {
    const t = await dueTenant()
    await enableModule(t.X, heldModule, OPERATOR, lifecycleDeps(platform, server)) // the switch-on inside the 30 days restores
    await platform`UPDATE plt.module_karenz SET state = 'restored', restore_requested_at = coalesce(restore_requested_at, now()), restored_at = now() WHERE karenz_id = ${t.karenzId}`
    const asked = vi.fn(hold)
    const r = await finalizeDueKarenz(finDeps(heldModule, { now: () => new Date(), exportHold: asked }))
    expect(r).toMatchObject({ finalized: 0, kept: 0, errors: [] })
    expect(asked).not.toHaveBeenCalled()
    expect(existsSync(t.exportPath)).toBe(false)
    expect(await databasesOn(server.admin)).toContain(t.db) // a restored module's database is not touched
    expect((await karenz(t.X)).export_deleted_at).toBeInstanceOf(Date)
  })

  it('a crash after the database row went to dropped: the next run is asked again and keeps the export', async () => {
    const t = await dueTenant()
    const first = await finalizeDueKarenz(
      finDeps(heldModule, {
        now: () => new Date(),
        hooks: {
          afterStep: (step) => {
            if (step === 'cas-dropped') throw new Error('crash after the drop')
          },
        },
      }),
    )
    expect(first.errors).toHaveLength(1)
    let k = await karenz(t.X)
    expect(k).toMatchObject({ state: 'finalizing', platform_done_at: null, export_kept_until: null })
    expect(await moduleDatabaseState(t.X)).toBe('dropped')
    expect(existsSync(t.exportPath)).toBe(true)

    const asked = vi.fn(hold)
    const second = await finalizeDueKarenz(finDeps(heldModule, { now: () => new Date(), exportHold: asked }))
    expect(second).toMatchObject({ finalized: 1, kept: 1, errors: [] })
    expect(asked).toHaveBeenCalledWith(t.X, 'lcfix', { karenzState: 'finalizing', databaseDropped: true, finalAt: k.final_at })
    k = await karenz(t.X)
    expect(k.export_kept_until?.getTime()).toBe(k.final_at.getTime() + KEEP_DAYS * DAY)
    expect(existsSync(t.exportPath)).toBe(true)
    expect(existsSync(`${t.exportPath}.sha256`)).toBe(true)
  })

  it('a throw from the hold after the drop leaves the export and the row open; the next run keeps it', async () => {
    const t = await dueTenant()
    const first = await finalizeDueKarenz(
      finDeps(heldModule, {
        now: () => new Date(),
        exportHold: () => {
          throw new Error('the hold failed')
        },
      }),
    )
    expect(first.errors).toHaveLength(1)
    expect(first.errors[0]?.message).toMatch(/hold failed/)
    expect(existsSync(t.exportPath)).toBe(true)
    expect(await moduleDatabaseState(t.X)).toBe('dropped')
    expect(await karenz(t.X)).toMatchObject({ state: 'finalizing', platform_done_at: null })

    const second = await finalizeDueKarenz(finDeps(heldModule, { now: () => new Date() }))
    expect(second).toMatchObject({ finalized: 1, kept: 1, errors: [] })
    expect(existsSync(t.exportPath)).toBe(true)
    expect((await karenz(t.X)).export_kept_until).toBeInstanceOf(Date)
  })

  it('a failed UPDATE of export_kept_until after the drop leaves the export; the next run keeps it', async () => {
    const t = await dueTenant()
    let failures = 1
    const flaky = new Proxy(platform, {
      apply(target, thisArg, args: unknown[]) {
        const text = Array.isArray(args[0]) ? (args[0] as string[]).join('?') : ''
        if (failures > 0 && /SET export_kept_until/.test(text)) {
          failures -= 1
          return Promise.reject(new Error('the platform write failed'))
        }
        return Reflect.apply(target, thisArg, args)
      },
    })
    const first = await finalizeDueKarenz(finDeps(heldModule, { platform: flaky, now: () => new Date() }))
    expect(first.errors).toHaveLength(1)
    expect(first.errors[0]?.message).toMatch(/platform write failed/)
    expect(existsSync(t.exportPath)).toBe(true)
    expect(await karenz(t.X)).toMatchObject({ state: 'finalizing', platform_done_at: null, export_kept_until: null })

    const second = await finalizeDueKarenz(finDeps(heldModule, { now: () => new Date() }))
    expect(second).toMatchObject({ finalized: 1, kept: 1, errors: [] })
    expect(existsSync(t.exportPath)).toBe(true)
  })

  it('with the deletion switch off nothing is dropped, deleted or held, and the hold is never asked', async () => {
    const t = await dueTenant()
    const asked = vi.fn(hold)
    const r = await finalizeDueKarenz(finDeps(heldModule, { finalDeletion: false, now: () => new Date(), exportHold: asked }))
    expect(r).toMatchObject({ due: 1, finalized: 0, kept: 0, dryRun: true, errors: [] })
    expect(asked).not.toHaveBeenCalled()
    expect(await databasesOn(server.admin)).toContain(t.db)
    expect(existsSync(t.exportPath)).toBe(true)
    expect(await karenz(t.X)).toMatchObject({ state: 'open', export_kept_until: null, export_deleted_at: null })
  })
})
