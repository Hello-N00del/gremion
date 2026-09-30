// packages/tenant-store/src/lifecycle/kernel.ts
//
// TASK-043 G1 / Q3: one customer's KERNEL database on the kernel server,
// t_<tenant hex32>__kernel (the TASK-021 Q6 name the TRD-089 inspection
// already expects), and its three roles:
//   k_<hex32>_owner   NOLOGIN, owns the database and (after the migration,
//                     which runs AS the owner) every object in it;
//   k_<hex32>_app     LOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE, SCRAM verifier;
//                     a member of the owner (named deviation until TASK-192:
//                     gremion-ui's boot fleet still runs DDL as the app);
//   k_<hex32>_purger  NOLOGIN, NOT a member of the owner (retention jobs).
// Then: PUBLIC loses CONNECT and TEMPORARY, the app gains CONNECT; timezone
// UTC; PUBLIC loses CREATE on schema public; pgbouncer.get_auth (the
// auth_query PgBouncer resolves SCRAM verifiers through, which the old
// createDatabaseAndRole also installed).
//
// It NEVER migrates: the kernel-data chain is gremion-ui's (db.ts
// runMigrations, the (filename, applied_at) ledger); running it with this
// package's runner would leave a sha256 NOT NULL ledger that every later
// app-run migration fails on (23502). The database it leaves is empty.
// Every identifier is validated here and quoted by the server (ddl.ts); one
// CREATE DATABASE site per database kind.
import type { Sql } from '@gremion/db'
import { assertTenantId, tenantModuleDbName } from '../names.js'
import { execFormatted, sqlState } from './ddl.js'
import { lockDownDatabase } from './enable.js'
import { LifecycleError, NEVER_OPENED } from './guards.js'
import { scramSha256Verifier } from './scram.js'
import type { ModuleServer } from './types.js'

export const KERNEL_MODULE = 'kernel'

export interface KernelRoles {
  owner: string
  app: string
  purger: string
}

export interface EnsureKernelResult extends KernelRoles {
  dbName: string
  /** true when this call created the database. */
  created: boolean
}

function assertTenant(tenantId: string): string {
  try {
    assertTenantId(tenantId)
  } catch (err) {
    throw new LifecycleError('INVALID_INPUT', (err as Error).message, { cause: err })
  }
  return tenantId.replaceAll('-', '')
}

/** t_<hex32>__kernel. */
export function kernelDbName(tenantId: string): string {
  assertTenant(tenantId)
  return tenantModuleDbName(tenantId, KERNEL_MODULE)
}

export function kernelRoles(tenantId: string): KernelRoles {
  const hex = assertTenant(tenantId)
  return { owner: `k_${hex}_owner`, app: `k_${hex}_app`, purger: `k_${hex}_purger` }
}

const ATTRS = 'NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'

async function roleExists(admin: Sql, role: string): Promise<boolean> {
  return (await admin`SELECT 1 FROM pg_roles WHERE rolname = ${role}`).length === 1
}

async function ensureRole(admin: Sql, role: string, login: 'LOGIN' | 'NOLOGIN'): Promise<void> {
  if (!(await roleExists(admin, role))) {
    try {
      await execFormatted(admin, `CREATE ROLE %I ${login} ${ATTRS}`, [role])
    } catch (err) {
      if (sqlState(err) !== '42710') throw err // a concurrent run created it
    }
  }
  await execFormatted(admin, `ALTER ROLE %I ${login} ${ATTRS}`, [role])
}

async function databaseOwner(admin: Sql, dbName: string): Promise<string | null> {
  const rows = await admin<{ owner: string }[]>`
    SELECT r.rolname AS owner FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = ${dbName}`
  return rows[0]?.owner ?? null
}

/** The three roles, the app's verifier and the memberships (idempotent). */
export async function ensureKernelRoles(admin: Sql, tenantId: string, appPassword: string): Promise<KernelRoles> {
  const roles = kernelRoles(tenantId)
  await ensureRole(admin, roles.owner, 'NOLOGIN')
  await ensureRole(admin, roles.app, 'LOGIN')
  await ensureRole(admin, roles.purger, 'NOLOGIN')
  await execFormatted(admin, 'ALTER ROLE %I PASSWORD %L', [roles.app, scramSha256Verifier(appPassword)])
  // Q3 deviation (TASK-192): the app keeps owner membership while gremion-ui's
  // boot fleet runs the kernel chain as the app. The purger never does.
  await execFormatted(admin, 'GRANT %I TO %I', [roles.owner, roles.app])
  const purgerInOwner = await admin`
    SELECT 1 FROM pg_auth_members m JOIN pg_roles o ON o.oid = m.roleid JOIN pg_roles p ON p.oid = m.member
     WHERE o.rolname = ${roles.owner} AND p.rolname = ${roles.purger}`
  if (purgerInOwner.length) await execFormatted(admin, 'REVOKE %I FROM %I', [roles.owner, roles.purger])
  return roles
}

const GET_AUTH = `
  CREATE SCHEMA IF NOT EXISTS pgbouncer;
  CREATE OR REPLACE FUNCTION pgbouncer.get_auth(uname text)
    RETURNS TABLE (usename name, passwd text)
    LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog
    AS $func$ SELECT usename, passwd FROM pg_catalog.pg_shadow WHERE usename = uname $func$;
  REVOKE ALL ON FUNCTION pgbouncer.get_auth(text) FROM PUBLIC;`

/**
 * Creates (or re-asserts) the customer's kernel database and roles on the
 * kernel server. `server.admin` is the server's POSTGRES_USER (CREATEDB,
 * CREATEROLE, and superuser for pgbouncer.get_auth's pg_shadow read);
 * `server.open(db)` opens the new database as that admin.
 */
export async function ensureKernelDatabase(server: ModuleServer, tenantId: string, appPassword: string): Promise<EnsureKernelResult> {
  const dbName = kernelDbName(tenantId)
  if (NEVER_OPENED.has(dbName)) throw new LifecycleError('TARGET_REFUSED', `refusing ${dbName}`)
  const roles = await ensureKernelRoles(server.admin, tenantId, appPassword)

  let created = false
  let owner = await databaseOwner(server.admin, dbName)
  if (owner === null) {
    try {
      await execFormatted(server.admin, 'CREATE DATABASE %I OWNER %I', [dbName, roles.owner])
      created = true
    } catch (err) {
      if (sqlState(err) !== '42P04') throw err
    }
    owner = await databaseOwner(server.admin, dbName)
  }
  if (owner !== roles.owner) {
    throw new LifecycleError('DATABASE_FOREIGN_OWNER', `${dbName} exists but is owned by ${owner ?? 'nobody'}, not ${roles.owner}: refusing to adopt a database the lifecycle did not create`)
  }
  await lockDownDatabase(server.admin, dbName, roles.app)
  await execFormatted(server.admin, 'ALTER DATABASE %I SET timezone TO %L', [dbName, 'UTC'])

  const db = await server.open(dbName)
  try {
    const [who] = await db<{ db: string }[]>`SELECT current_database() AS db`
    if (who?.db !== dbName) throw new LifecycleError('TARGET_REFUSED', `the admin pool is connected to ${JSON.stringify(who?.db)}, not ${dbName}`)
    await db.unsafe('REVOKE CREATE ON SCHEMA public FROM PUBLIC')
    await db.unsafe(GET_AUTH)
    const [auth] = await db<{ present: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pgbouncer_auth') AS present`
    if (auth?.present) {
      await db.unsafe('GRANT USAGE ON SCHEMA pgbouncer TO pgbouncer_auth')
      await db.unsafe('GRANT EXECUTE ON FUNCTION pgbouncer.get_auth(text) TO pgbouncer_auth')
    }
  } finally {
    await db.end({ timeout: 5 })
  }
  return { dbName, created, ...roles }
}

/** The inverse, for delete: DROP DATABASE ... WITH (FORCE), then the three roles. Idempotent. */
export async function dropKernelDatabase(server: ModuleServer, tenantId: string): Promise<{ dbName: string; dropped: boolean }> {
  const dbName = kernelDbName(tenantId)
  const roles = kernelRoles(tenantId)
  const owner = await databaseOwner(server.admin, dbName)
  if (owner !== null && owner !== roles.owner) {
    throw new LifecycleError('DATABASE_FOREIGN_OWNER', `${dbName} is owned by ${owner}, not ${roles.owner}: refusing to drop it`)
  }
  if (owner !== null) await execFormatted(server.admin, 'DROP DATABASE IF EXISTS %I WITH (FORCE)', [dbName])
  for (const role of [roles.app, roles.purger, roles.owner]) {
    if (await roleExists(server.admin, role)) await execFormatted(server.admin, 'DROP ROLE %I', [role])
  }
  return { dbName, dropped: owner !== null }
}
