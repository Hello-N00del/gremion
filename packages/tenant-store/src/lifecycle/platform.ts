// packages/tenant-store/src/lifecycle/platform.ts
//
// gremion_platform (SCHEMA §0.1, schema plt): where enablement and the
// per-(customer, module) database state live (TASK-021 Q2). The lifecycle
// never opens the legacy `control` database; its ledger
// (schema_migrations(filename, applied_at), no sha256) is incompatible with
// the one runner, which is why the platform catalogue is a separate database.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Sql } from '@gremion/db'
import { runMigrations, type RunMigrationsResult } from '../runner.js'
import { LifecycleError } from './guards.js'

export const PLATFORM_DATABASE = 'gremion_platform'

function migrationsDir(): string {
  // src/lifecycle/platform-migrations from the sources; a built copy
  // (dist/lifecycle) reads the shipped src/ folder (package.json "files").
  for (const rel of ['./platform-migrations/', '../../src/lifecycle/platform-migrations/']) {
    const dir = fileURLToPath(new URL(rel, import.meta.url))
    if (existsSync(dir)) return dir
  }
  return fileURLToPath(new URL('./platform-migrations/', import.meta.url))
}

/** The platform catalogue's one migration folder (sha256 manifest), run by runMigrations. */
export const PLATFORM_MIGRATIONS_DIR = migrationsDir()

/** Throws unless `sql` is connected to gremion_platform. */
export async function assertPlatform(sql: Sql): Promise<void> {
  const [row] = await sql<{ db: string }[]>`SELECT current_database() AS db`
  if (row?.db !== PLATFORM_DATABASE) {
    throw new LifecycleError('NOT_PLATFORM', `the platform connection is to ${JSON.stringify(row?.db)}, not ${PLATFORM_DATABASE}`)
  }
}

/** Migrates gremion_platform with the one runner (DL-001). `sql` needs a direct pool of >= 2. */
export async function migratePlatform(sql: Sql, opts: { log?: (line: string) => void } = {}): Promise<RunMigrationsResult> {
  await assertPlatform(sql)
  return runMigrations({ sql, dir: PLATFORM_MIGRATIONS_DIR, ...(opts.log ? { log: opts.log } : {}) })
}

export interface ModuleVersionRow {
  moduleId: string
  moduleVersionId: string
}

/**
 * plt.module + plt.module_version for (module_key, semver). The rows are
 * loaded by TASK-077's registry; the lifecycle refuses a module or version
 * the catalogue has not registered.
 */
export async function lookupModuleVersion(sql: Sql, moduleKey: string, semver: string): Promise<ModuleVersionRow | null> {
  const rows = await sql<{ module_id: string; module_version_id: string }[]>`
    SELECT m.module_id::text, v.module_version_id::text
      FROM plt.module m JOIN plt.module_version v ON v.module_id = m.module_id
     WHERE m.module_key = ${moduleKey} AND v.semver = ${semver}`
  const r = rows[0]
  return r ? { moduleId: r.module_id, moduleVersionId: r.module_version_id } : null
}

export async function lookupModuleId(sql: Sql, moduleKey: string): Promise<string | null> {
  const rows = await sql<{ module_id: string }[]>`SELECT module_id::text FROM plt.module WHERE module_key = ${moduleKey}`
  return rows[0]?.module_id ?? null
}

export type ModuleDatabaseState = 'enabling' | 'enabled' | 'disabling' | 'dropped'

export interface ModuleDatabaseRow {
  dbName: string
  state: ModuleDatabaseState
  exportSha256: string | null
  exportedAt: Date | null
}

export async function readModuleDatabase(sql: Sql, customerId: string, moduleId: string): Promise<ModuleDatabaseRow | null> {
  const rows = await sql<{ db_name: string; state: ModuleDatabaseState; export_sha256: string | null; exported_at: Date | null }[]>`
    SELECT db_name, state, export_sha256, exported_at
      FROM plt.module_database
     WHERE customer_id = ${customerId} AND module_id = ${moduleId}`
  const r = rows[0]
  return r ? { dbName: r.db_name, state: r.state, exportSha256: r.export_sha256, exportedAt: r.exported_at } : null
}

/** Compare-and-set of plt.module_database.state; false when the row was not in `from`. */
export async function casModuleDatabaseState(
  sql: Sql,
  key: { customerId: string; moduleId: string },
  from: readonly ModuleDatabaseState[],
  to: ModuleDatabaseState,
): Promise<boolean> {
  const rows = await sql`
    UPDATE plt.module_database
       SET state = ${to},
           dropped_at = CASE WHEN ${to} = 'dropped' THEN now() ELSE NULL END,
           export_path   = CASE WHEN ${to} = 'disabling' AND state <> 'disabling' THEN NULL ELSE export_path END,
           export_sha256 = CASE WHEN ${to} = 'disabling' AND state <> 'disabling' THEN NULL ELSE export_sha256 END,
           export_bytes  = CASE WHEN ${to} = 'disabling' AND state <> 'disabling' THEN NULL ELSE export_bytes END,
           exported_at   = CASE WHEN ${to} = 'disabling' AND state <> 'disabling' THEN NULL ELSE exported_at END
     WHERE customer_id = ${key.customerId} AND module_id = ${key.moduleId} AND state = ANY(${[...from]}::text[])
     RETURNING 1`
  return rows.length === 1
}
