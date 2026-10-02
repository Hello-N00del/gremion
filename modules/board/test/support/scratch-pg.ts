// modules/board/test/support/scratch-pg.ts
//
// The board suites' ONE place that opens a direct connection to the scratch
// Postgres server (BOARD_TEST_PG_URL, fail-closed through pg-test-guard.ts). A
// destructive scratch-server proof, not a tenant connection: it CREATEs, migrates
// and DROPs the fixture (tenant, board) databases (only the names
// assertScratchTenantDb accepts) and a board_test_* decoy, and it inspects
// pg_database / pg_stat_activity as the server's superuser. The leaf itself is
// never given these connections: it opens its tenant databases through
// @gremion/tenant-store (buildApp). Allow-listed in
// packages/tenant-store/scripts/tenant-db-access.allow.json.
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { runMigrations, tenantModuleDbName } from '@gremion/tenant-store'
import { assertSafeTestEnv, assertScratchTenantDb, requireEphemeralTestPgUrl } from './pg-test-guard.ts'

export type ScratchSql = postgres.Sql<{}>

/** The board module's migrations (manifest.json + *.sql), from the source tree. */
export const BOARD_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url))

const TEST_DB_PREFIX = 'board_test_'

/** The scratch server's url (maintenance database), guarded. */
export function scratchServerUrl(): string {
  const url = requireEphemeralTestPgUrl()
  assertSafeTestEnv(url, TEST_DB_PREFIX)
  return url
}

/** A url for `db` on the scratch server, optionally as another user. */
export function scratchDbUrl(db: string, user?: string): string {
  const u = new URL(scratchServerUrl())
  u.pathname = `/${db}`
  if (user !== undefined) {
    u.username = user
    u.password = ''
  }
  return u.toString()
}

/** The scratch server's url (maintenance database) as a LOGIN role, e.g. the module's app role. */
export function scratchServerUrlAs(user: string, password: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(user)) throw new Error(`[scratch-pg] refusing user ${JSON.stringify(user)}`)
  const u = new URL(scratchServerUrl())
  u.username = user
  u.password = encodeURIComponent(password)
  return u.toString()
}

function assertScratchName(db: string): void {
  if (db.startsWith(TEST_DB_PREFIX) && /^[a-z0-9_]{1,63}$/.test(db)) return
  assertScratchTenantDb(db)
}

/** The server superuser on the maintenance database. */
export function connectAdmin(): ScratchSql {
  return postgres(scratchServerUrl(), { max: 2, prepare: false, onnotice: () => {} })
}

/** The superuser on one scratch database; `role` sets the startup role (options=-c role=<role>). */
export function connectScratchDb(db: string, opts: { max?: number; role?: string } = {}): ScratchSql {
  if (db !== 'gremion_platform') assertScratchName(db)
  if (opts.role !== undefined && !/^[a-z][a-z0-9_]{0,62}$/.test(opts.role)) throw new Error(`[scratch-pg] refusing role ${JSON.stringify(opts.role)}`)
  return postgres(scratchDbUrl(db), {
    max: opts.max ?? 2,
    prepare: false,
    onnotice: () => {},
    ...(opts.role ? { connection: { options: `-c role=${opts.role}` } } : {}),
  })
}

/** t_<hex32>__board of a fixture tenant (refuses any other tenant). */
export function tenantBoardDb(tenantId: string): string {
  const name = tenantModuleDbName(tenantId, 'board')
  assertScratchTenantDb(name)
  return name
}

export async function dropScratchDb(admin: ScratchSql, db: string): Promise<void> {
  assertScratchName(db)
  await admin.unsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`)
}

/** Drops and re-creates `db` empty: no ledger, no tables. */
export async function createEmptyDb(admin: ScratchSql, db: string): Promise<void> {
  await dropScratchDb(admin, db)
  await admin.unsafe(`CREATE DATABASE "${db}"`)
}

/**
 * Creates `db` and migrates it with the ONE runner (@gremion/tenant-store's
 * runMigrations — the runner enableModule uses at its step 7), over a direct
 * pool of 2.
 */
export async function provisionDb(admin: ScratchSql, db: string): Promise<void> {
  await createEmptyDb(admin, db)
  const sql = connectScratchDb(db, { max: 2 })
  try {
    await runMigrations({ sql, dir: BOARD_MIGRATIONS_DIR, log: () => {} })
  } finally {
    await sql.end({ timeout: 5 })
  }
}

export async function databaseNames(admin: ScratchSql): Promise<string[]> {
  return (await admin<{ datname: string }[]>`SELECT datname FROM pg_database ORDER BY datname`).map((r) => r.datname)
}

/** User tables (outside pg_catalog / information_schema) in `db`. */
export async function userTableCount(db: string): Promise<number> {
  const sql = connectScratchDb(db, { max: 1 })
  try {
    const [r] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`
    return r!.n
  } finally {
    await sql.end({ timeout: 5 })
  }
}
