// packages/tenant-store/src/lifecycle/disable.ts
//
// disableModule(tenant, module, actor, deps): TRD-424, export first, then BLOCK
// (module Karenz, 2026-10-30: nothing is dropped for 30 days).
//   1. validate; assert gremion_platform; refuse while a restore is pending
//   2. one platform transaction: module_database -> 'disabling' (clearing the
//      previous export record) and module_enablement -> 'disabled', so the
//      level-1 switch is off before the dump starts
//   3. pg_dump -Fc, then verify: size > 0, pg_restore --list parses it and
//      names the database, sha256 written beside it and into the row
//   4. only then: the app role loses CONNECT and its sessions end
//      (blockModuleDatabase; the target re-asserted, t_<hex32>__<module>)
//   5. one platform transaction: 'disabling' -> 'blocked' and the 30-day clock,
//      one plt.module_karenz row carrying the path and checksum of THIS export
// The database itself is dropped on day 30 by finalizeDueKarenz (karenz.ts), and
// only against the export the row owns. A switch-on within the 30 days unblocks
// it (enable.ts). A failed or unverifiable export throws and leaves the database
// in place and the row 'disabling'; calling disableModule again resumes with a
// fresh export (the earlier attempt's file is removed, it was never recorded).
// A platform server's databases (runtime.platformServer, e.g. synapse) are
// never touched: they are not (tenant, module) databases.
import { rmSync } from 'node:fs'
import type { Sql } from '@gremion/db'
import { tenantModuleDbName } from '../names.js'
import { blockModuleDatabase } from './block.js'
import { execFormatted } from './ddl.js'
import { assertActor } from './enable.js'
import { exportDatabase } from './export.js'
import {
  assertKarenzExportPath,
  assertLifecycleModuleId,
  assertLifecycleTenantId,
  assertTenantModuleTarget,
  LifecycleError,
  moduleRoles,
} from './guards.js'
import { assertPlatform, casModuleDatabaseState, lookupModuleId, openKarenz, readLiveKarenz, readModuleDatabase } from './platform.js'
import type { Actor, DisableResult, LifecycleDeps, LifecycleModule } from './types.js'

export { blockModuleDatabase } from './block.js'

async function databaseExists(admin: Sql, dbName: string): Promise<boolean> {
  const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`
  return rows.length === 1
}

/** Turns the level-1 switch off; the number of rows it changed (0 when the module was already off or never on). */
async function disableEnablement(platform: Sql, customerId: string, moduleId: string, actor: Actor): Promise<number> {
  const rows = await platform`
    UPDATE plt.module_enablement
       SET state = 'disabled', updated_by_kind = ${actor.kind}, updated_by = ${actor.id}
     WHERE customer_id = ${customerId} AND module_id = ${moduleId} AND state <> 'disabled'
     RETURNING 1`
  return rows.length
}

/** §9: the one DROP the lifecycle runs. The target is re-asserted here, at the call. */
export async function dropTenantModuleDatabase(admin: Sql, dbName: string, tenantId: string, moduleId: string): Promise<void> {
  assertTenantModuleTarget(dbName, tenantId, moduleId)
  await execFormatted(admin, 'DROP DATABASE IF EXISTS %I WITH (FORCE)', [dbName])
}

export async function disableModule(tenantId: string, module: LifecycleModule, actor: Actor, deps: LifecycleDeps): Promise<DisableResult> {
  assertLifecycleTenantId(tenantId)
  const moduleId = module?.id
  assertLifecycleModuleId(moduleId)
  if (module.moduleJson?.id !== moduleId) throw new LifecycleError('INVALID_INPUT', `module.json id ${JSON.stringify(module.moduleJson?.id)} is not ${moduleId}`)
  assertActor(actor)
  const log = deps.log ?? (() => {})
  await assertPlatform(deps.platform)
  const pltModuleId = await lookupModuleId(deps.platform, moduleId)
  if (!pltModuleId) throw new LifecycleError('MODULE_UNKNOWN', `plt.module has no module_key ${moduleId}`)
  const key = { customerId: tenantId, moduleId: pltModuleId }
  const hook = async (step: 'disabling' | 'exported' | 'blocked' | 'dropped', db: string | null) => deps.hooks?.afterStep?.(step, { tenantId, moduleId, database: db })
  const database = module.moduleJson.runtime.database

  // A restore still running owns the module's external items (locked polls, archived rooms): a second
  // switch-off must not adopt them into a new Karenz (Review Focus 2).
  const live = await readLiveKarenz(deps.platform, tenantId, pltModuleId)
  if (live?.state === 'restoring') {
    throw new LifecycleError('KARENZ_RESTORE_PENDING', `(${tenantId}, ${moduleId}) is being restored (Karenz ${live.karenzId}); switch it off again once the restore has finished`)
  }

  const row = database ? await readModuleDatabase(deps.platform, tenantId, pltModuleId) : null
  if (!database || !row || row.state === 'dropped') {
    // No database to keep: only the enablement, and for a module that declares none, the Karenz row.
    // One transaction, so a crash cannot leave the module off with no clock.
    const out = await deps.platform.begin(async (tx) => {
      const changed = await disableEnablement(tx as unknown as Sql, tenantId, pltModuleId, actor)
      if (!database && changed > 0) {
        return { changed, karenz: await openKarenz(tx as unknown as Sql, { customerId: tenantId, moduleId: pltModuleId, actor, exportPath: null, exportSha256: null }) }
      }
      return { changed, karenz: null }
    })
    const karenz = out.karenz ?? (!database ? await readLiveKarenz(deps.platform, tenantId, pltModuleId) : null)
    return {
      tenantId,
      moduleId,
      database: row?.dbName ?? null,
      dropped: false,
      blocked: false,
      karenz: karenz ? { karenzId: karenz.karenzId, finalAt: karenz.finalAt } : null,
      export: null,
      noop: out.changed === 0,
    }
  }
  const dbName = assertTenantModuleTarget(tenantModuleDbName(tenantId, moduleId), tenantId, moduleId)
  if (row.dbName !== dbName) throw new LifecycleError('TARGET_REFUSED', `plt.module_database names ${row.dbName} for (${tenantId}, ${moduleId}), expected ${dbName}`)

  if (row.state === 'blocked') {
    // Already blocked: the Karenz keeps its clock. The switch and the block are re-asserted (blocking is
    // idempotent and proves the post-condition, so blocked:true is never reported over a database the app
    // role can still reach: a restore that failed half way, a grant made by hand), and a blocked database
    // that somehow has no clock gets one (it would otherwise never be finalized).
    const server = deps.server(database.postgresService)
    if (await databaseExists(server.admin, dbName)) {
      await blockModuleDatabase(server.admin, dbName, tenantId, moduleId, moduleRoles(moduleId).app)
    } else {
      log(`${dbName} is recorded as blocked but the server has no such database: nothing to block (the day-30 job records it as dropped)`)
    }
    const karenz = await deps.platform.begin(async (tx) => {
      await disableEnablement(tx as unknown as Sql, tenantId, pltModuleId, actor)
      return openKarenz(tx as unknown as Sql, { customerId: tenantId, moduleId: pltModuleId, actor, exportPath: row.exportPath, exportSha256: row.exportSha256 })
    })
    return { tenantId, moduleId, database: dbName, dropped: false, blocked: true, karenz, export: null, noop: true }
  }

  // 2. disabling + the switch off, together
  await deps.platform.begin(async (tx) => {
    const moved = await casModuleDatabaseState(tx as unknown as Sql, key, ['enabling', 'enabled', 'disabling'], 'disabling')
    if (!moved) throw new LifecycleError('CONCURRENT_STATE', `${dbName} left its state while being disabled`)
    await disableEnablement(tx as unknown as Sql, tenantId, pltModuleId, actor)
  })
  await hook('disabling', dbName)

  const server = deps.server(database.postgresService)
  if (!(await databaseExists(server.admin, dbName))) {
    const again = await readModuleDatabase(deps.platform, tenantId, pltModuleId)
    if (again?.exportedAt) {
      // a drop of an earlier (pre-Karenz) disable happened, the 'dropped' write did not: finish it. Since the
      // Karenz this code never drops, so the row is a leftover of the release before it: say so in the log.
      log(`${dbName} is gone and its export ${again.exportPath ?? '(unrecorded)'} (sha256 ${again.exportSha256 ?? 'none'}) was recorded by an earlier switch-off: finishing that switch-off, no Karenz row is opened for it`)
      await casModuleDatabaseState(deps.platform, key, ['disabling'], 'dropped')
      return { tenantId, moduleId, database: dbName, dropped: true, blocked: false, karenz: null, export: null, noop: false }
    }
    // never created (an enable that stopped before CREATE DATABASE): nothing to export or block
    await deps.platform`DELETE FROM plt.module_database WHERE customer_id = ${tenantId} AND module_id = ${pltModuleId} AND state = 'disabling' AND exported_at IS NULL`
    log(`${dbName} was never created; its enabling record is removed`)
    return { tenantId, moduleId, database: dbName, dropped: false, blocked: false, karenz: null, export: null, noop: false }
  }

  // 3. export and verify; a failure throws here and nothing is blocked
  const earlier = (await readModuleDatabase(deps.platform, tenantId, pltModuleId))?.exportPath ?? null
  const exp = await exportDatabase(deps.exporter, { service: database.postgresService, database: dbName }, { exportDir: deps.exportDir, tenantId, moduleId })
  const recorded = await deps.platform`
    UPDATE plt.module_database
       SET export_path = ${exp.path}, export_sha256 = ${exp.sha256}, export_bytes = ${exp.bytes}, exported_at = now()
     WHERE customer_id = ${tenantId} AND module_id = ${pltModuleId} AND state = 'disabling'
     RETURNING 1`
  if (recorded.length !== 1) throw new LifecycleError('CONCURRENT_STATE', `${dbName} left 'disabling' before its export was recorded`)
  if (earlier && earlier !== exp.path) {
    // the export of an attempt that stopped before the block: never owned by a Karenz row, so no job would ever delete it
    try {
      assertKarenzExportPath(earlier, deps.exportDir, tenantId, moduleId)
      rmSync(earlier, { force: true })
      rmSync(`${earlier}.sha256`, { force: true })
    } catch (err) {
      log(`could not remove the export of the earlier attempt ${earlier}: ${(err as Error).message}`)
    }
  }
  await hook('exported', dbName)

  // 4. the block, only against the export the platform row holds
  const check = await readModuleDatabase(deps.platform, tenantId, pltModuleId)
  if (check?.state !== 'disabling' || check.exportSha256 !== exp.sha256 || check.exportedAt === null) {
    throw new LifecycleError('EXPORT_UNVERIFIED', `the platform row of ${dbName} does not hold this export (sha256 ${exp.sha256}); refusing to block`)
  }
  await blockModuleDatabase(server.admin, dbName, tenantId, moduleId, moduleRoles(moduleId).app)

  // 5. blocked + the clock, together; the row copies the path and checksum of this export
  const karenz = await deps.platform.begin(async (tx) => {
    if (!(await casModuleDatabaseState(tx as unknown as Sql, key, ['disabling'], 'blocked'))) {
      throw new LifecycleError('CONCURRENT_STATE', `${dbName} was blocked but its row left 'disabling'`)
    }
    return openKarenz(tx as unknown as Sql, { customerId: tenantId, moduleId: pltModuleId, actor, exportPath: exp.path, exportSha256: exp.sha256 })
  })
  await hook('blocked', dbName)
  log(`disabled (${tenantId}, ${moduleId}): exported ${exp.bytes} bytes to ${exp.path} (sha256 ${exp.sha256}), then blocked ${dbName} until ${karenz.finalAt.toISOString()}`)
  return { tenantId, moduleId, database: dbName, dropped: false, blocked: true, karenz, export: exp, noop: false }
}
