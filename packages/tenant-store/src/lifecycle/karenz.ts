// packages/tenant-store/src/lifecycle/karenz.ts
//
// The module Karenz (2026-10-30): a switch-off no longer drops the module
// database. disableModule exports and BLOCKS it and opens one plt.module_karenz
// row (the authoritative 30-day clock); enableModule inside the 30 days
// unblocks it. This file is day 30: finalizeDueKarenz drops what is still
// blocked and deletes the row's own export, behind a deletion switch that ships
// OFF (then it only records the dry-run mode and counts what is due).
//
// Each sub-step of a row is keyed on PERSISTED state, never on memory, so a crash
// at any point converges on the next run:
//   open --CAS--> finalizing
//   module_database blocked --(verify the ROW's export, DROP IF EXISTS)--> dropped
//   export file + sidecar deleted (a missing file is success) --> export_deleted_at
//   platform_done_at (finalized when the tenant side has reported too)
// Nothing here trusts a council report to delete: the clock and the blocked state
// are platform columns only (Open Decision 8).
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Sql } from '@gremion/db'
import { tenantModuleDbName } from '../names.js'
import { dropTenantModuleDatabase } from './disable.js'
import { removeKarenzExport, type ExportStorageFactory } from './export-remove.js'
import { assertKarenzExportPath, assertTenantModuleTarget, LifecycleError } from './guards.js'
import { casModuleDatabaseState, readModuleDatabase, type KarenzState } from './platform.js'
import type { LifecycleModule, ModuleServer } from './types.js'

export { assertKarenzExportPath } from './guards.js'
export { blockModuleDatabase } from './disable.js'
export { unblockModuleDatabase } from './enable.js'
export { KARENZ_DAYS } from './platform.js'
export type { KarenzState } from './platform.js'

/** The deletion switch: true only for the exact string `on`. The shipped value is `off` (a dry run). */
export function finalDeletionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.KARENZ_FINAL_DELETION === 'on'
}

export type FinalizeStep = 'cas-finalizing' | 'export-verified' | 'db-dropped' | 'cas-dropped' | 'export-deleted' | 'platform-done'

export interface FinalizeDeps {
  /** A connection to gremion_platform AS its owner. */
  platform: Sql
  /** The server behind a compose service name (runtime.database.postgresService). */
  server: (service: string) => ModuleServer
  catalogue: readonly LifecycleModule[]
  exportDir: string
  /** The storage backend over the export volume, one per tenant; default a LocalStorageBackend rooted at exportDir (export-remove.ts). */
  exportStorage?: ExportStorageFactory
  /** false: a dry run. Mode is recorded on each due row, nothing is dropped or deleted. */
  finalDeletion: boolean
  /** Wall-clock budget; checked before each row (default 110000). */
  deadlineMs?: number
  now?: () => Date
  /** A future date keeps the export (a retention hold, phase 3); the row records export_kept_until. */
  exportHold?: (tenantId: string, moduleId: string) => Promise<Date | null> | Date | null
  /** Modules (catalogue ids) whose database may not be dropped before retained_ok_at is set. */
  retentionRequired?: ReadonlySet<string>
  log?: (line: string) => void
  hooks?: { afterStep?: (step: FinalizeStep) => void | Promise<void> }
}

export interface FinalizeResult {
  /** Rows awaiting the platform's day-30 work (or the deletion of a leftover export). */
  due: number
  /** Rows whose platform side completed in this run. */
  finalized: number
  /** Rows whose export is kept by an exportHold. */
  kept: number
  dryRun: boolean
  errors: { karenzId: string; moduleKey: string; message: string }[]
  /** Dumps under <exportDir>/<tenant>/<module>/ that no Karenz row and no module_database row references (strays of a failed attempt). Listed every run, never deleted. */
  orphanedExports: string[]
}

interface DueRow {
  karenz_id: string
  customer_id: string
  module_id: string
  module_key: string
  state: KarenzState
  export_path: string | null
  export_sha256: string | null
  export_deleted_at: Date | null
  platform_done_at: Date | null
  tenant_done_at: Date | null
  retained_ok_at: Date | null
}

function sha256File(file: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256')
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', rej)
      .on('end', () => res(h.digest('hex')))
  })
}

function describeError(err: unknown): string {
  if (err instanceof LifecycleError) return `${err.code}: ${err.message}`
  return err instanceof Error ? err.message : String(err)
}

/**
 * Dumps in the export tree that no row references: a file written by an attempt that failed before it was
 * recorded. Exports of disables from before the Karenz stay referenced by plt.module_database.export_path
 * and are therefore not listed.
 */
async function findOrphanedExports(platform: Sql, exportDir: string): Promise<string[]> {
  if (!existsSync(exportDir)) return []
  const known = new Set<string>()
  for (const r of await platform<{ p: string }[]>`SELECT export_path AS p FROM plt.module_karenz WHERE export_path IS NOT NULL`) known.add(resolve(r.p))
  for (const r of await platform<{ p: string }[]>`SELECT export_path AS p FROM plt.module_database WHERE export_path IS NOT NULL`) known.add(resolve(r.p))
  const orphans: string[] = []
  for (const tenant of readdirSync(exportDir, { withFileTypes: true })) {
    if (!tenant.isDirectory()) continue
    for (const mod of readdirSync(join(exportDir, tenant.name), { withFileTypes: true })) {
      if (!mod.isDirectory()) continue
      for (const f of readdirSync(join(exportDir, tenant.name, mod.name), { withFileTypes: true })) {
        if (!f.isFile() || !f.name.endsWith('.dump')) continue
        const path = join(exportDir, tenant.name, mod.name, f.name)
        if (!known.has(resolve(path))) orphans.push(path)
      }
    }
  }
  return orphans.sort()
}

/**
 * Day 30 of every Karenz row that is due (final_at passed). Idempotent and
 * restart-safe. Never throws for one row: it collects `errors` and goes on, so a
 * single bad export cannot stop the others. Candidates:
 *   A. open or finalizing rows past final_at whose platform side is not done;
 *   B. a closed or finishing row (restored, finalizing, finalized) past final_at
 *      whose own export file still exists (a restored Karenz must not leave its
 *      export on disk forever, RC-MOD-EXPORT; a hold that has ended).
 * Every run records the mode (`dry` or `live`) on the A rows first: the tenant
 * pass reads it from the row, never from its own environment.
 */
export async function finalizeDueKarenz(deps: FinalizeDeps): Promise<FinalizeResult> {
  const log = deps.log ?? (() => {})
  const now = (deps.now ?? (() => new Date()))()
  const deadline = Date.now() + (deps.deadlineMs ?? 110_000)
  const mode = deps.finalDeletion ? 'live' : 'dry'
  const result: FinalizeResult = { due: 0, finalized: 0, kept: 0, dryRun: !deps.finalDeletion, errors: [], orphanedExports: [] }
  const hook = async (step: FinalizeStep) => deps.hooks?.afterStep?.(step)

  await deps.platform`
    UPDATE plt.module_karenz
       SET final_mode = ${mode}
     WHERE state IN ('open', 'finalizing') AND final_at <= ${now} AND platform_done_at IS NULL AND final_mode IS DISTINCT FROM ${mode}`

  const rows = await deps.platform<DueRow[]>`
    SELECT k.karenz_id::text, k.customer_id::text, k.module_id::text, m.module_key, k.state, k.export_path, k.export_sha256,
           k.export_deleted_at, k.platform_done_at, k.tenant_done_at, k.retained_ok_at
      FROM plt.module_karenz k JOIN plt.module m ON m.module_id = k.module_id
     WHERE k.final_at <= ${now}
       AND ((k.state IN ('open', 'finalizing') AND k.platform_done_at IS NULL)
            OR (k.state IN ('restored', 'finalizing', 'finalized') AND k.export_path IS NOT NULL AND k.export_deleted_at IS NULL
                AND (k.export_kept_until IS NULL OR k.export_kept_until <= ${now})))
     ORDER BY k.final_at, k.karenz_id`
  result.due = rows.length
  // Informational only: a tree that cannot be walked must never stop the destructive per-row pass below.
  try {
    result.orphanedExports = await findOrphanedExports(deps.platform, deps.exportDir)
  } catch (err) {
    log(`the orphaned-export scan failed and is skipped for this run: ${describeError(err)}`)
  }

  if (!deps.finalDeletion) {
    for (const r of rows) log(`dry run: would finalize ${r.module_key} of ${r.customer_id} (Karenz ${r.karenz_id}, state ${r.state})`)
    return result
  }

  for (const r of rows) {
    if (Date.now() > deadline) {
      log(`deadline reached: ${rows.length - rows.indexOf(r)} row(s) left for the next run`)
      break
    }
    try {
      const outcome = await finalizeRow(deps, r, hook, log)
      if (outcome.platformDone) result.finalized += 1
      if (outcome.kept) result.kept += 1
    } catch (err) {
      result.errors.push({ karenzId: r.karenz_id, moduleKey: r.module_key, message: describeError(err) })
    }
  }
  return result
}

async function finalizeRow(
  deps: FinalizeDeps,
  r: DueRow,
  hook: (step: FinalizeStep) => Promise<void>,
  log: (line: string) => void,
): Promise<{ platformDone: boolean; kept: boolean }> {
  const tenantId = r.customer_id
  const moduleKey = r.module_key
  const platformSide = r.state === 'open' || (r.state === 'finalizing' && r.platform_done_at === null)

  let blockedDb: { dbName: string; admin: Sql } | null = null
  if (platformSide) {
    const mod = deps.catalogue.find((m) => m.id === moduleKey)
    if (!mod) throw new LifecycleError('MODULE_UNKNOWN', `module ${moduleKey} is not in the catalogue; its Karenz ${r.karenz_id} cannot be finalized`)
    if (deps.retentionRequired?.has(moduleKey) && r.retained_ok_at === null) {
      throw new LifecycleError('GATE_REFUSED', `module ${moduleKey} has records under a retention duty and no sealed copy is recorded (retained_ok_at); refusing to drop its database`)
    }
    const database = mod.moduleJson.runtime.database
    if (database) {
      const md = await readModuleDatabase(deps.platform, tenantId, r.module_id)
      if (md && md.state !== 'dropped') {
        if (md.state !== 'blocked') {
          throw new LifecycleError('CONCURRENT_STATE', `${md.dbName} is ${md.state}, not blocked: refusing to drop it for Karenz ${r.karenz_id}`)
        }
        const dbName = assertTenantModuleTarget(tenantModuleDbName(tenantId, moduleKey), tenantId, moduleKey)
        if (md.dbName !== dbName) throw new LifecycleError('TARGET_REFUSED', `plt.module_database names ${md.dbName}, expected ${dbName}`)
        // The ROW's own export, not the latest one of the module: a later switch-off must not be able to
        // satisfy (or spoil) this check. Verified BEFORE the row is claimed, so a missing export leaves the
        // switch-on possible instead of freezing the module in `finalizing` with an intact database.
        await verifyRowExport(deps.exportDir, r)
        await hook('export-verified')
        blockedDb = { dbName, admin: deps.server(database.postgresService).admin }
      }
    }
  }

  if (r.state === 'open') {
    if (!(await claimForFinalizing(deps.platform, r.karenz_id, deps.now?.() ?? new Date()))) {
      log(`Karenz ${r.karenz_id} is no longer open (a restore or another run holds it): skipped`)
      return { platformDone: false, kept: false }
    }
    await hook('cas-finalizing')
  }

  if (blockedDb) {
    await dropTenantModuleDatabase(blockedDb.admin, blockedDb.dbName, tenantId, moduleKey)
    await hook('db-dropped')
    if (!(await casModuleDatabaseState(deps.platform, { customerId: tenantId, moduleId: r.module_id }, ['blocked'], 'dropped'))) {
      throw new LifecycleError('CONCURRENT_STATE', `${blockedDb.dbName} was dropped but its row left 'blocked'`)
    }
    await hook('cas-dropped')
    log(`dropped ${blockedDb.dbName} (Karenz ${r.karenz_id})`)
  }

  let kept = false
  if (r.export_path !== null && r.export_deleted_at === null) {
    const hold = await deps.exportHold?.(tenantId, moduleKey)
    if (hold && hold.getTime() > (deps.now?.() ?? new Date()).getTime()) {
      await deps.platform`UPDATE plt.module_karenz SET export_kept_until = ${hold} WHERE karenz_id = ${r.karenz_id}`
      kept = true
      log(`export of Karenz ${r.karenz_id} kept until ${hold.toISOString()}`)
    } else {
      await removeKarenzExport(r.export_path, deps, tenantId, moduleKey)
      await deps.platform`UPDATE plt.module_karenz SET export_deleted_at = now() WHERE karenz_id = ${r.karenz_id} AND export_deleted_at IS NULL`
      await hook('export-deleted')
    }
  }

  let platformDone = false
  if (platformSide) {
    await deps.platform`
      UPDATE plt.module_karenz
         SET platform_done_at = now(),
             state = CASE WHEN tenant_done_at IS NOT NULL THEN 'finalized' ELSE state END
       WHERE karenz_id = ${r.karenz_id} AND platform_done_at IS NULL`
    platformDone = true
    await hook('platform-done')
  }
  return { platformDone, kept }
}

/** Re-reads the row's own export and refuses unless the file is there and its sha256 is the recorded one. */
async function verifyRowExport(exportDir: string, r: DueRow): Promise<void> {
  if (r.export_path === null || r.export_sha256 === null) {
    throw new LifecycleError('EXPORT_MISSING', `Karenz ${r.karenz_id} records no export of its own; refusing to drop the database`)
  }
  const path = assertKarenzExportPath(r.export_path, exportDir, r.customer_id, r.module_key)
  if (!existsSync(path)) {
    throw new LifecycleError('EXPORT_MISSING', `the export ${path} of Karenz ${r.karenz_id} is missing; refusing to drop the database`)
  }
  const actual = await sha256File(path)
  if (actual !== r.export_sha256) {
    throw new LifecycleError('EXPORT_MISSING', `the export ${path} of Karenz ${r.karenz_id} has sha256 ${actual}, the row records ${r.export_sha256}; refusing to drop the database`)
  }
}

/**
 * open -> finalizing under the row lock the restore also takes (enableModule locks
 * the same row FOR UPDATE): SKIP LOCKED means that a restore in flight wins and
 * this run leaves the row alone. False when the row was not claimed.
 */
async function claimForFinalizing(platform: Sql, karenzId: string, now: Date): Promise<boolean> {
  return platform.begin(async (tx) => {
    const [row] = await tx<{ state: string }[]>`
      SELECT state FROM plt.module_karenz WHERE karenz_id = ${karenzId} AND final_at <= ${now} FOR UPDATE SKIP LOCKED`
    if (row?.state !== 'open') return false
    await tx`UPDATE plt.module_karenz SET state = 'finalizing' WHERE karenz_id = ${karenzId}`
    return true
  })
}
