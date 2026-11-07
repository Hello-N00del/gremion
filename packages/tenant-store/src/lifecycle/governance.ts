// packages/tenant-store/src/lifecycle/governance.ts
//
// TASK-084-a: one customer's GOVERNANCE database on the dedicated
// governance-postgres server, t_<tenant hex32>__governance, and its roles:
//   g_<hex32>_owner   NOLOGIN, owns the database and every object in it (the
//                     migration runs AS the owner, through the admin pool);
//   g_<hex32>_app     LOGIN NOBYPASSRLS, SCRAM verifier; NOT a member of the
//                     owner (the service credential must neither SET ROLE to
//                     the table owner nor write the migration ledger);
//   g_<hex32>_purger  NOLOGIN, no password at rest.
// Two cluster-wide group roles (gov_app, gov_purger; NOLOGIN NOBYPASSRLS)
// carry the table grants of the migration; the customer roles inherit them.
// CONNECT on a governance database goes only to that customer's three roles.
import type { Sql } from '@gremion/db'
import { assertTenantId, tenantModuleDbName } from '../names.js'
import { hasControlChar, runMigrations } from '../runner.js'
import { execFormatted, sqlState } from './ddl.js'
import { lockDownDatabase, openAsOwner } from './enable.js'
import { LifecycleError, NEVER_OPENED } from './guards.js'
import { asAdminIn } from './kernel.js'
import { scramSha256Verifier } from './scram.js'
import type { ModuleServer } from './types.js'

export const GOVERNANCE_MODULE = 'governance'
/** The migration ledger of the governance chain (the runner creates it). */
export const GOVERNANCE_LEDGER = 'gov.schema_migration'

/** Cluster-wide group roles that carry the migration's table grants. */
export const GOVERNANCE_GROUP_ROLES: Readonly<{ app: 'gov_app'; purger: 'gov_purger' }> = Object.freeze({
  app: 'gov_app',
  purger: 'gov_purger',
} as const)

export interface GovernanceRoles {
  owner: string
  app: string
  purger: string
}

function assertTenant(tenantId: string): string {
  try {
    assertTenantId(tenantId)
  } catch (err) {
    throw new LifecycleError('INVALID_INPUT', (err as Error).message, { cause: err })
  }
  return tenantId.replaceAll('-', '')
}

/** t_<hex32>__governance. */
export function governanceDbName(tenantId: string): string {
  assertTenant(tenantId)
  return tenantModuleDbName(tenantId, GOVERNANCE_MODULE)
}

export function governanceRoles(tenantId: string): GovernanceRoles {
  const hex = assertTenant(tenantId)
  return { owner: `g_${hex}_owner`, app: `g_${hex}_app`, purger: `g_${hex}_purger` }
}

const ATTRS = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'

export interface EnsureGovernanceResult extends GovernanceRoles {
  dbName: string
  /** true when this call created the database. */
  created: boolean
}

/** 16-256 printable ASCII: the app role's password (never logged). */
const APP_PASSWORD = /^[\x20-\x7e]{16,256}$/

/** A concurrent run created or updated the same cluster-wide role. */
function isRoleRace(err: unknown): boolean {
  const state = sqlState(err)
  if (state === '42710' || state === '23505') return true
  return /tuple concurrently (updated|deleted)/.test(String((err as Error | null)?.message ?? ''))
}

async function withRaceRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= 3 || !isRoleRace(err)) throw err
    }
  }
}

interface RoleRow {
  canlogin: boolean
  super: boolean
  createdb: boolean
  createrole: boolean
  repl: boolean
  bypassrls: boolean
}

async function readRole(admin: Sql, role: string): Promise<RoleRow | null> {
  const rows = await admin<RoleRow[]>`
    SELECT rolcanlogin AS canlogin, rolsuper AS super, rolcreatedb AS createdb, rolcreaterole AS createrole,
           rolreplication AS repl, rolbypassrls AS bypassrls
      FROM pg_roles WHERE rolname = ${role}`
  return rows[0] ?? null
}

/** Creates the role if absent and re-asserts its attributes ONLY when they differ (a rerun writes nothing). */
async function ensureRole(admin: Sql, role: string, login: 'LOGIN' | 'NOLOGIN'): Promise<void> {
  const want = login === 'LOGIN'
  const ok = (r: RoleRow | null) => r !== null && r.canlogin === want && !r.super && !r.createdb && !r.createrole && !r.repl && !r.bypassrls
  if (ok(await readRole(admin, role))) return
  await withRaceRetry(async () => {
    if ((await readRole(admin, role)) === null) {
      try {
        await execFormatted(admin, `CREATE ROLE %I ${login} ${ATTRS}`, [role])
      } catch (err) {
        if (sqlState(err) !== '42710') throw err
      }
    }
    if (!ok(await readRole(admin, role))) await execFormatted(admin, `ALTER ROLE %I ${login} ${ATTRS}`, [role])
  })
}

interface Membership {
  inherit: boolean
  set: boolean
  admin: boolean
}

async function membership(admin: Sql, group: string, member: string): Promise<Membership | null> {
  const rows = await admin<Membership[]>`
    SELECT am.inherit_option AS inherit, am.set_option AS set, am.admin_option AS admin
      FROM pg_auth_members am JOIN pg_roles g ON g.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
     WHERE g.rolname = ${group} AND m.rolname = ${member}`
  return rows[0] ?? null
}

/** GRANT <group> TO <member> WITH INHERIT TRUE, SET FALSE, ADMIN FALSE, only when it is not already exactly that. */
async function ensureMembership(admin: Sql, group: string, member: string): Promise<void> {
  const m = await membership(admin, group, member)
  if (m && m.inherit && !m.set && !m.admin) return
  await withRaceRetry(() => execFormatted(admin, 'GRANT %I TO %I WITH INHERIT TRUE, SET FALSE, ADMIN FALSE', [group, member]))
}

async function databaseOwner(admin: Sql, dbName: string): Promise<string | null> {
  const rows = await admin<{ owner: string }[]>`
    SELECT r.rolname AS owner FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.oid = d.datdba WHERE d.datname = ${dbName}`
  return rows[0]?.owner ?? null
}

/** Who holds which privilege on the database: 'PUBLIC' for grantee 0. */
async function databaseAcl(admin: Sql, dbName: string): Promise<{ grantee: string; priv: string }[]> {
  return admin<{ grantee: string; priv: string }[]>`
    SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE g.rolname END AS grantee, x.privilege_type AS priv
      FROM pg_catalog.pg_database d
     CROSS JOIN LATERAL pg_catalog.aclexplode(d.datacl) x
      LEFT JOIN pg_catalog.pg_roles g ON g.oid = x.grantee
     WHERE d.datname = ${dbName}`
}

/**
 * Creates (or re-asserts) the customer's governance database and roles on the
 * governance server. `server.admin` is the server's POSTGRES_USER. Idempotent,
 * and a rerun over a finished database issues no DDL except the password
 * verifier (the one thing the caller's secret can change). CONNECT goes ONLY
 * to this customer's three roles: never PUBLIC, never gov_app / gov_purger.
 */
export async function ensureGovernanceDatabase(server: ModuleServer, tenantId: string, appPassword: string): Promise<EnsureGovernanceResult> {
  const dbName = governanceDbName(tenantId)
  const roles = governanceRoles(tenantId)
  if (typeof appPassword !== 'string' || !APP_PASSWORD.test(appPassword)) {
    throw new LifecycleError('INVALID_INPUT', 'the governance app password must be 16-256 printable ASCII characters')
  }
  if (NEVER_OPENED.has(dbName)) throw new LifecycleError('TARGET_REFUSED', `refusing ${dbName}`)
  const admin = server.admin

  // cluster-wide group roles first (two customers may be created at once)
  await ensureRole(admin, GOVERNANCE_GROUP_ROLES.app, 'NOLOGIN')
  await ensureRole(admin, GOVERNANCE_GROUP_ROLES.purger, 'NOLOGIN')
  // the customer's roles: owner and purger NOLOGIN, the app LOGIN
  await ensureRole(admin, roles.owner, 'NOLOGIN')
  await ensureRole(admin, roles.app, 'LOGIN')
  await ensureRole(admin, roles.purger, 'NOLOGIN')
  // at rest the purger has no credential; the app's verifier is the caller's secret
  await execFormatted(admin, 'ALTER ROLE %I PASSWORD NULL', [roles.purger])
  await execFormatted(admin, 'ALTER ROLE %I PASSWORD %L', [roles.app, scramSha256Verifier(appPassword)])
  await ensureMembership(admin, GOVERNANCE_GROUP_ROLES.app, roles.app)
  await ensureMembership(admin, GOVERNANCE_GROUP_ROLES.purger, roles.purger)
  // DV1: the app is NEVER a member of the owner (it must not SET ROLE to the table owner
  // nor write the migration ledger); a membership found here is removed.
  const stray = [
    [roles.owner, roles.app],
    [roles.owner, roles.purger],
    [GOVERNANCE_GROUP_ROLES.purger, roles.app],
    [GOVERNANCE_GROUP_ROLES.app, roles.purger],
  ] as const
  for (const [role, member] of stray) {
    if (await membership(admin, role, member)) await execFormatted(admin, 'REVOKE %I FROM %I', [role, member])
  }

  let created = false
  let owner = await databaseOwner(admin, dbName)
  if (owner === null) {
    try {
      await execFormatted(admin, 'CREATE DATABASE %I OWNER %I', [dbName, roles.owner])
      created = true
    } catch (err) {
      if (sqlState(err) !== '42P04') throw err
    }
    owner = await databaseOwner(admin, dbName)
  }
  if (owner !== roles.owner) {
    throw new LifecycleError('DATABASE_FOREIGN_OWNER', `${dbName} exists but is owned by ${owner ?? 'nobody'}, not ${roles.owner}: refusing to adopt a database the lifecycle did not create`)
  }

  // CONNECT: exactly the customer's three roles, nothing for PUBLIC
  const acl = await databaseAcl(admin, dbName)
  const connect = new Set(acl.filter((x) => x.priv === 'CONNECT').map((x) => x.grantee))
  const own = new Set([roles.owner, roles.app, roles.purger])
  // any other grantee (PUBLIC, a group role, a stray login) is repaired, not only reported
  const strays = [...new Set(acl.map((x) => x.grantee))].filter((g) => !own.has(g))
  const locked = acl.length > 0 && strays.length === 0 && [...own].every((r) => connect.has(r))
  if (!locked) {
    for (const g of strays) if (g !== 'PUBLIC') await execFormatted(admin, 'REVOKE ALL ON DATABASE %I FROM %I', [dbName, g])
    await lockDownDatabase(admin, dbName, roles.app)
    await execFormatted(admin, 'GRANT CONNECT ON DATABASE %I TO %I', [dbName, roles.purger])
    await execFormatted(admin, 'GRANT CONNECT ON DATABASE %I TO %I', [dbName, roles.owner])
  }
  const [tz] = await admin<{ set: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_database d ON d.oid = s.setdatabase
                    WHERE d.datname = ${dbName} AND s.setrole = 0
                      AND EXISTS (SELECT 1 FROM pg_catalog.unnest(s.setconfig) c WHERE pg_catalog.lower(c) = 'timezone=utc')) AS set`
  if (!tz?.set) await execFormatted(admin, 'ALTER DATABASE %I SET timezone TO %L', [dbName, 'UTC'])

  const db = await server.open(dbName)
  try {
    await asAdminIn(db, async (tx) => {
      const [who] = await tx<{ db: string }[]>`SELECT pg_catalog.current_database() AS db`
      if (who?.db !== dbName) throw new LifecycleError('TARGET_REFUSED', `the admin pool is connected to ${JSON.stringify(who?.db)}, not ${dbName}`)
      const [pub] = await tx<{ can: boolean }[]>`SELECT pg_catalog.has_schema_privilege('public', 'public', 'CREATE') AS can`
      if (pub?.can) await tx.unsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
    })
  } finally {
    await db.end({ timeout: 5 })
  }
  return { dbName, created, ...roles }
}

/** The inverse, for tests and a future customer delete: DROP DATABASE ... WITH (FORCE), then the three roles. The group roles stay. Idempotent. */
export async function dropGovernanceDatabase(server: ModuleServer, tenantId: string): Promise<{ dbName: string; dropped: boolean }> {
  const dbName = governanceDbName(tenantId)
  const roles = governanceRoles(tenantId)
  const owner = await databaseOwner(server.admin, dbName)
  if (owner !== null && owner !== roles.owner) {
    throw new LifecycleError('DATABASE_FOREIGN_OWNER', `${dbName} is owned by ${owner}, not ${roles.owner}: refusing to drop it`)
  }
  if (owner !== null) await execFormatted(server.admin, 'DROP DATABASE IF EXISTS %I WITH (FORCE)', [dbName])
  for (const role of [roles.app, roles.purger, roles.owner]) {
    if ((await readRole(server.admin, role)) !== null) await execFormatted(server.admin, 'DROP ROLE %I', [role])
  }
  return { dbName, dropped: owner !== null }
}

export interface MigrateGovernanceOptions {
  /** The governance migrations directory (services/governance/migrations, holding manifest.json). */
  dir: string
  /** The release this run ships (ledger release_ref, 1-64 printable characters). */
  releaseRef: string
  log?: (line: string) => void
}

/**
 * Applies the governance chain to the customer's governance database AS the
 * customer's owner role (DV1: the server admin pool opened with startup role
 * g_<hex32>_owner, the enableModule pattern). Every object is therefore owned
 * by the owner, the app role is not a member of it, and the migration ledger
 * (GOVERNANCE_LEDGER) is writable only by the owner. Idempotent: a second run
 * applies nothing.
 */
export async function migrateGovernanceDatabase(
  server: ModuleServer,
  tenantId: string,
  opts: MigrateGovernanceOptions,
): Promise<{ applied: string[]; alreadyApplied: number }> {
  const dbName = governanceDbName(tenantId)
  const roles = governanceRoles(tenantId)
  const ref = opts?.releaseRef
  if (typeof ref !== 'string' || ref.length < 1 || ref.length > 64 || hasControlChar(ref)) {
    throw new LifecycleError('INVALID_INPUT', 'releaseRef (the release this run ships) must be 1-64 printable characters')
  }
  const sql = await openAsOwner(server, dbName, roles.owner)
  try {
    const r = await runMigrations({ sql, dir: opts.dir, ledger: GOVERNANCE_LEDGER, releaseRef: ref, ...(opts.log ? { log: opts.log } : {}) })
    return { applied: r.applied, alreadyApplied: r.alreadyApplied }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** gov.database_binding.tenant_token CHECK (SCHEMA 0.6). */
const TENANT_TOKEN = /^[a-z][a-z0-9_]{2,39}$/

/**
 * Binds the database to its customer: one row in gov.database_binding
 * (singleton). A row that already exists (this customer's, or ANOTHER's) is
 * left alone: `inserted` is false and governancePostCondition reports whose
 * row it is.
 */
export async function bindGovernanceDatabase(server: ModuleServer, tenant: { id: string; token: string }): Promise<{ inserted: boolean }> {
  const dbName = governanceDbName(tenant?.id)
  const roles = governanceRoles(tenant.id)
  if (typeof tenant.token !== 'string' || !TENANT_TOKEN.test(tenant.token)) {
    throw new LifecycleError('INVALID_INPUT', `tenant token ${JSON.stringify(tenant.token)} does not match ${TENANT_TOKEN.source}`)
  }
  const sql = await openAsOwner(server, dbName, roles.owner)
  try {
    const r = await sql`
      INSERT INTO gov.database_binding (customer_id, tenant_token, context_code)
      VALUES (${tenant.id}, ${tenant.token}, 'gov')
      ON CONFLICT (singleton) DO NOTHING`
    return { inserted: r.count > 0 }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

export interface GovernanceDbState {
  binding: { customerId: string; tenantToken: string; contextCode: string } | null
  ledger: { filename: string; sha256: string }[]
  /** Tables of schema gov with a customer_id column (database_binding excepted) that lack ENABLE + FORCE row level security. */
  unforcedRlsTables: string[]
  /** Sorted roles holding CONNECT on the database; 'PUBLIC' for grantee 0. */
  connectGrantees: string[]
  currentDatabase: string
}

/**
 * Reads the post-condition of the governance step FROM THE DATABASE, never from
 * a runner's return value: the binding row, the ledger, the row level security
 * flags, the CONNECT list and where the pool really is. Runs as the server
 * admin with every name pg_catalog-qualified (the owner may plant objects).
 */
export async function governancePostCondition(server: ModuleServer, tenantId: string): Promise<GovernanceDbState> {
  const dbName = governanceDbName(tenantId)
  const grants = await server.admin<{ grantee: string }[]>`
    SELECT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE g.rolname END AS grantee
      FROM pg_catalog.pg_database d
     CROSS JOIN LATERAL pg_catalog.aclexplode(d.datacl) x
      LEFT JOIN pg_catalog.pg_roles g ON g.oid = x.grantee
     WHERE d.datname = ${dbName} AND x.privilege_type = 'CONNECT'`
  const connectGrantees = [...new Set(grants.map((x) => x.grantee))].sort()
  const db = await server.open(dbName)
  try {
    return await asAdminIn(db, async (tx) => {
      const [who] = await tx<{ db: string }[]>`SELECT pg_catalog.current_database() AS db`
      // an unmigrated database reports "no binding, empty ledger" (the step then fails naming it), it does not throw
      const [have] = await tx<{ binding: boolean; ledger: boolean }[]>`
        SELECT pg_catalog.to_regclass('gov.database_binding') IS NOT NULL AS binding, pg_catalog.to_regclass('gov.schema_migration') IS NOT NULL AS ledger`
      const binding = have?.binding
        ? await tx<{ customer_id: string; tenant_token: string; context_code: string }[]>`
            SELECT customer_id::pg_catalog.text AS customer_id, tenant_token, context_code FROM gov.database_binding`
        : []
      const ledger = have?.ledger ? await tx<{ filename: string; sha256: string }[]>`SELECT filename, sha256 FROM gov.schema_migration ORDER BY filename` : []
      const unforced = await tx<{ relname: string }[]>`
        SELECT c.relname::pg_catalog.text AS relname
          FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'gov'
          JOIN pg_catalog.pg_attribute at ON at.attrelid = c.oid AND at.attname = 'customer_id' AND NOT at.attisdropped
         WHERE c.relkind = 'r' AND c.relname <> 'database_binding'
           AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
         ORDER BY 1`
      const b = binding[0]
      return {
        binding: b ? { customerId: b.customer_id, tenantToken: b.tenant_token, contextCode: b.context_code } : null,
        ledger: ledger.map((r) => ({ filename: r.filename, sha256: r.sha256 })),
        unforcedRlsTables: unforced.map((r) => r.relname),
        connectGrantees,
        currentDatabase: who?.db ?? '',
      }
    })
  } finally {
    await db.end({ timeout: 5 })
  }
}
