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
import { pinnedPhaseFor, type PhaseFor } from '../phase.js'
import { PINNED_BASELINE } from '../phase-baseline.js'
import { runMigrations, type RunMigrationsHooks, type RunMigrationsResult } from '../runner.js'
import { execFormatted, sqlState } from './ddl.js'
import { LifecycleError } from './guards.js'
import { scramSha256Verifier } from './scram.js'

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

export interface EnsurePlatformResult {
  owner: string
  /** true when this call created the database. */
  created: boolean
}

const PLATFORM_OWNER = /^[a-z][a-z0-9_]{0,62}$/
/** The COMMENT a role this function created carries: only such a role (or the database's owner) is adopted. */
export const PLATFORM_OWNER_MARK = 'gremion: owner of gremion_platform (TASK-043 ensurePlatformDatabase)'

/**
 * TASK-043 G1 / Q15: creates gremion_platform on the kernel server if it is
 * absent, owned by `owner` (a LOGIN role, NOSUPERUSER NOCREATEDB NOCREATEROLE,
 * its password set as a SCRAM verifier), with PUBLIC's CONNECT and TEMPORARY
 * revoked. `admin` is the kernel server's POSTGRES_USER on its maintenance
 * database. Idempotent; refuses a gremion_platform owned by anyone else.
 * It does not migrate: migratePlatform (on a connection AS the owner) does.
 */
export async function ensurePlatformDatabase(admin: Sql, opts: { owner: string; ownerPassword: string }): Promise<EnsurePlatformResult> {
  const { owner } = opts
  if (typeof owner !== 'string' || !PLATFORM_OWNER.test(owner) || owner === 'postgres' || owner.startsWith('pg_')) {
    throw new LifecycleError('INVALID_INPUT', `platform owner role ${JSON.stringify(owner)} is not a plain lowercase role name`)
  }
  const [me] = await admin<{ u: string }[]>`SELECT current_user AS u`
  if (owner === me?.u) throw new LifecycleError('INVALID_INPUT', `platform owner role ${owner} is the server's own admin role`)
  const current = async () =>
    (
      await admin<{ owner: string }[]>`
        SELECT r.rolname AS owner FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = ${PLATFORM_DATABASE}`
    )[0]?.owner ?? null
  // Every refusal BEFORE any role is touched (review B1, r2): a foreign owner
  // of gremion_platform, and an existing role this function did not create
  // (marked by COMMENT) that does not already own it -- a misconfigured owner
  // name must never demote and re-password another service's role.
  let have = await current()
  if (have !== null && have !== owner) {
    throw new LifecycleError('DATABASE_FOREIGN_OWNER', `${PLATFORM_DATABASE} exists but is owned by ${have}, not ${owner}`)
  }
  const attrs = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  const [existing] = await admin<{ marked: boolean }[]>`
    SELECT coalesce(shobj_description(oid, 'pg_authid'), '') = ${PLATFORM_OWNER_MARK} AS marked FROM pg_roles WHERE rolname = ${owner}`
  if (!existing) {
    try {
      await execFormatted(admin, `CREATE ROLE %I ${attrs}`, [owner])
    } catch (err) {
      if (sqlState(err) !== '42710') throw err
    }
    await execFormatted(admin, 'COMMENT ON ROLE %I IS %L', [owner, PLATFORM_OWNER_MARK])
  } else if (!existing.marked && have !== owner) {
    throw new LifecycleError('INVALID_INPUT', `role ${owner} already exists and was not created as the platform owner: refusing to adopt (and demote) it`)
  }
  await execFormatted(admin, `ALTER ROLE %I ${attrs}`, [owner])
  await execFormatted(admin, 'ALTER ROLE %I PASSWORD %L', [owner, scramSha256Verifier(opts.ownerPassword)])
  let created = false
  if (have === null) {
    try {
      await execFormatted(admin, 'CREATE DATABASE %I OWNER %I', [PLATFORM_DATABASE, owner])
      created = true
    } catch (err) {
      if (sqlState(err) !== '42P04') throw err
    }
    have = await current()
  }
  if (have !== owner) {
    throw new LifecycleError('DATABASE_FOREIGN_OWNER', `${PLATFORM_DATABASE} exists but is owned by ${have ?? 'nobody'}, not ${owner}`)
  }
  await execFormatted(admin, 'REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', [PLATFORM_DATABASE])
  await execFormatted(admin, 'GRANT CONNECT ON DATABASE %I TO %I', [PLATFORM_DATABASE, owner])
  return { owner, created }
}

/** Throws unless `sql` is connected to gremion_platform. */
export async function assertPlatform(sql: Sql): Promise<void> {
  const [row] = await sql<{ db: string }[]>`SELECT current_database() AS db`
  if (row?.db !== PLATFORM_DATABASE) {
    throw new LifecycleError('NOT_PLATFORM', `the platform connection is to ${JSON.stringify(row?.db)}, not ${PLATFORM_DATABASE}`)
  }
}

/** The register chain of gremion_platform (scripts/migrations/ranges.json). */
export const PLATFORM_CHAIN = 'platform'

export interface MigratePlatformOptions {
  log?: (line: string) => void
  /** TASK-075: the release this run ships (ledger release_ref, 1-64 characters). */
  releaseRef: string
  /**
   * TASK-075: phase of a headerless file; default the kernel baseline of chain
   * `platform` as this package ships it (PINNED_BASELINE), so a tree without
   * scripts/ (the tenant-create image) phases the same files a checkout does.
   */
  phaseFor?: PhaseFor
  /** TASK-075: e.g. cli.ts's composed chain check + pre-migration dump (an upgrade of an existing catalogue). */
  hooks?: RunMigrationsHooks
}

/** Migrates gremion_platform with the one runner (DL-001). `sql` needs a direct pool of >= 2. */
export async function migratePlatform(sql: Sql, opts: MigratePlatformOptions): Promise<RunMigrationsResult> {
  await assertPlatform(sql)
  return runMigrations({
    sql,
    dir: PLATFORM_MIGRATIONS_DIR,
    releaseRef: opts?.releaseRef,
    phaseFor: opts?.phaseFor ?? pinnedPhaseFor(PLATFORM_CHAIN, PINNED_BASELINE),
    ...(opts?.hooks ? { hooks: opts.hooks } : {}),
    ...(opts?.log ? { log: opts.log } : {}),
  })
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
