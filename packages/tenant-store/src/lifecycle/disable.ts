// packages/tenant-store/src/lifecycle/disable.ts
//
// disableModule(tenant, module, actor, deps): TRD-424, export first, then drop.
//   1. validate; assert gremion_platform
//   2. one platform transaction: module_database -> 'disabling' (clearing the
//      previous export record) and module_enablement -> 'disabled', so the
//      level-1 switch is off before the dump starts
//   3. pg_dump -Fc, then verify: size > 0, pg_restore --list parses it and
//      names the database, sha256 written beside it and into the row
//   4. only then: DROP DATABASE ... WITH (FORCE) — the target re-asserted
//      (t_<hex32>__<module>, never the tenant's kernel database) and the
//      recorded export re-read from the platform row, never from memory
//   5. 'dropped'
// A failed or unverifiable export throws and leaves the database in place and
// the row 'disabling'; calling disableModule again resumes with a fresh export.
// A platform server's databases (runtime.platformServer, e.g. synapse) are
// never touched: they are not (tenant, module) databases.
import type { Sql } from '@gremion/db'
import { tenantModuleDbName } from '../names.js'
import { execFormatted } from './ddl.js'
import { assertActor } from './enable.js'
import { exportDatabase } from './export.js'
import { assertLifecycleModuleId, assertLifecycleTenantId, assertTenantModuleTarget, LifecycleError } from './guards.js'
import { assertPlatform, casModuleDatabaseState, lookupModuleId, readModuleDatabase } from './platform.js'
import type { Actor, DisableResult, LifecycleDeps, LifecycleModule } from './types.js'

async function databaseExists(admin: Sql, dbName: string): Promise<boolean> {
  const rows = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`
  return rows.length === 1
}

async function disableEnablement(platform: Sql, customerId: string, moduleId: string, actor: Actor): Promise<void> {
  await platform`
    UPDATE plt.module_enablement
       SET state = 'disabled', updated_by_kind = ${actor.kind}, updated_by = ${actor.id}
     WHERE customer_id = ${customerId} AND module_id = ${moduleId} AND state <> 'disabled'`
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
  const hook = async (step: 'disabling' | 'exported' | 'dropped', db: string | null) => deps.hooks?.afterStep?.(step, { tenantId, moduleId, database: db })
  const database = module.moduleJson.runtime.database

  const row = database ? await readModuleDatabase(deps.platform, tenantId, pltModuleId) : null
  if (!database || !row || row.state === 'dropped') {
    await disableEnablement(deps.platform, tenantId, pltModuleId, actor)
    return { tenantId, moduleId, database: row?.dbName ?? null, dropped: false, export: null, noop: true }
  }
  const dbName = assertTenantModuleTarget(tenantModuleDbName(tenantId, moduleId), tenantId, moduleId)
  if (row.dbName !== dbName) throw new LifecycleError('TARGET_REFUSED', `plt.module_database names ${row.dbName} for (${tenantId}, ${moduleId}), expected ${dbName}`)

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
      // the drop happened, the 'dropped' write did not: finish it
      await casModuleDatabaseState(deps.platform, key, ['disabling'], 'dropped')
      return { tenantId, moduleId, database: dbName, dropped: true, export: null, noop: false }
    }
    // never created (an enable that stopped before CREATE DATABASE): nothing to export or drop
    await deps.platform`DELETE FROM plt.module_database WHERE customer_id = ${tenantId} AND module_id = ${pltModuleId} AND state = 'disabling' AND exported_at IS NULL`
    log(`${dbName} was never created; its enabling record is removed`)
    return { tenantId, moduleId, database: dbName, dropped: false, export: null, noop: false }
  }

  // 3. export and verify; a failure throws here and nothing is dropped
  const exp = await exportDatabase(deps.exporter, { service: database.postgresService, database: dbName }, { exportDir: deps.exportDir, tenantId, moduleId })
  const recorded = await deps.platform`
    UPDATE plt.module_database
       SET export_path = ${exp.path}, export_sha256 = ${exp.sha256}, export_bytes = ${exp.bytes}, exported_at = now()
     WHERE customer_id = ${tenantId} AND module_id = ${pltModuleId} AND state = 'disabling'
     RETURNING 1`
  if (recorded.length !== 1) throw new LifecycleError('CONCURRENT_STATE', `${dbName} left 'disabling' before its export was recorded`)
  await hook('exported', dbName)

  // 4. the drop, only against the export the platform row holds
  const check = await readModuleDatabase(deps.platform, tenantId, pltModuleId)
  if (check?.state !== 'disabling' || check.exportSha256 !== exp.sha256 || check.exportedAt === null) {
    throw new LifecycleError('EXPORT_UNVERIFIED', `the platform row of ${dbName} does not hold this export (sha256 ${exp.sha256}); refusing to drop`)
  }
  await dropTenantModuleDatabase(server.admin, dbName, tenantId, moduleId)
  if (!(await casModuleDatabaseState(deps.platform, key, ['disabling'], 'dropped'))) {
    throw new LifecycleError('CONCURRENT_STATE', `${dbName} was dropped but its row left 'disabling'`)
  }
  await hook('dropped', dbName)
  log(`disabled (${tenantId}, ${moduleId}): exported ${exp.bytes} bytes to ${exp.path} (sha256 ${exp.sha256}), then dropped ${dbName}`)
  return { tenantId, moduleId, database: dbName, dropped: true, export: exp, noop: false }
}
